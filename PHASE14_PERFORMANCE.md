# Phase 14 -- Performance Engineering

Status: complete. Every number was measured on this machine. Nothing is
projected, and where the measurement has a limit the limit is stated.

**Headline: 173 -> 1,064 requests/sec (6.1x), p99 309ms -> 123ms.**
Two code changes, both found by a profiler and neither visible in any metric
the system already had.

---

## 1. What we did

1. Corrected a wrong conclusion from Phase 8 about horizontal scaling.
2. Profiled the API under load and found 25.5% of CPU in a function that had no
   business running at all.
3. Cached the per-request user read, with an explicitly bounded staleness
   window and verified invalidation.
4. Established where the ceiling actually is now -- and it is the test harness,
   not the system.

Hinglish: is phase ka tareeka ek hi tha -- **pehle naapo, phir badlo.** Dono
optimisations aise the jo code padh kar kabhi nahi milte. Aur ek purana
conclusion galat nikla, jo isse bhi zyada important hai.

---

## 2. Correcting Phase 8: "three nodes gave no throughput gain"

Phase 8 ne honestly likha tha ki 1 node se 3 nodes karne par throughput nahi
badha. Woh conclusion **galat tha**, aur wajah measurement ki banawat thi.

### The arithmetic that was missing

Load generator ek fixed **concurrency** rakhta hai -- N requests hamesha
in-flight. Little's Law kehta hai:

```
concurrency = throughput x latency
```

Yaani `rps = concurrency / latency`. Agar aap concurrency fix rakhte ho, to
**throughput badh hi nahi sakta jab tak latency na gire.** Nodes add karne se
har node ka load kam hota hai, latency thodi behtar hoti hai, bas -- aur ek hi
concurrency point par dekhne se lagta hai "kuch nahi badla".

Baseline, 3 nodes, concurrency 20: rps 173, p50 101.72ms.
Check: 20 / 0.1157s = **173**. Bilkul match.

### What a correct measurement looks like

Capacity dekhni ho to concurrency **sweep** karo aur knee dhoondho. Same nginx,
sirf upstream list badal kar:

| concurrency | 1 node rps | 3 node rps | speedup |
|---|---|---|---|
| 5 | 177 | 262 | 1.48x |
| 10 | 213 | 327 | 1.54x |
| 20 | 230 | 343 | 1.49x |
| 40 | 239 | 351 | 1.47x |
| 80 | 264 | 365 | 1.38x |

To gain **hai** -- lagbhag 1.5x. Par 3x nahi. Ye doosra sawaal khada karta hai.

### Why 1.5x and not 3x

Saturation par CPU:

```
api-1 117.6%   api-2 123.0%   api-3 119.8%
postgres 105.6%   pgbouncer 41.7%   nginx 17.5%
TOTAL 537% of a nominal 1200%
```

Dekh kar lagta hai "bahut headroom hai". Lekin:

```
AMD Ryzen 5 4500
NumberOfCores             : 6
NumberOfLogicalProcessors : 12
```

**6 physical cores, 12 logical (SMT).** Docker ka CPU% logical CPUs ginta hai,
to "1200%" ka matlab 12 cores ki throughput nahi hai -- SMT siblings execution
units share karte hain. 537% containers + load generator (~100%, ek poora Node
process) + Windows + Docker Desktop + ek Supabase stack jo usi machine par chal
raha tha -- ye sab milkar 6 asli cores par baithe hain.

Phase 8 ka instinct ("CPU-bound on shared cores") **sahi tha**. Uska conclusion
("no throughput gain") galat tha. Farak ye hai ki instinct ek data point se
bana tha, aur sweep ne poori curve dikha di.

**Interview line:** "throughput nahi badha" kabhi bhi apne aap mein finding
nahi hoti. Pehle poochho: load generator concurrency fix rakhta hai ya arrival
rate? Fixed concurrency par rps latency ka ulta hota hai, aur aap capacity naap
hi nahi rahe -- aap latency naap rahe ho.

---

## 3. Decision 1: Profile before optimising (and what it found)

### The metrics were misleading -- all of them, and none of them were wrong

Optimise karne se pehle ye picture tha:

```
http_request_duration  /api/v1/auth/me  ->  318.3s / 2792 req = 114ms avg
db_query_duration      User.findUnique  ->  297.9s / 2807     = 106ms avg
```

Padhne par saaf lagta hai: "93% waqt database mein ja raha hai. Database theek
karo."

Phir Postgres se seedha poochha:

```
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM "user" WHERE id = ...
  Execution Time: 0.385 ms
```

**0.385 milliseconds.** Aur app usi cheez ko 106ms bata raha tha.

Dono numbers sach the. `db_query_duration` Prisma ke `$allOperations` extension
mein maapa jaata hai, jo connection acquire karna, Rust query engine tak IPC,
serialization, network, execution aur wapasi -- sab ginta hai. Usme "database"
ka hissa 0.385ms tha; baaki 105ms **kisi aur cheez ka intezaar** tha.

Event loop lag bhi dekha: mean 10.25ms, p99 11ms. Woh bhi 105ms nahi tha.

**Sabak:** aggregate metrics batate hain ki waqt kis LAYER mein gaya. Woh ye
nahi batate ki CPU kar kya raha hai. Uske liye profiler chahiye.

### The profile

Ek dedicated node `--cpu-prof` ke saath chalaya, sirf usi par load bheja:

```
WHERE CPU TIME GOES                              ms   share
(idle)                                        11829   26.8%
node core: node:internal/crypto/keys          11549   26.2%   <- ???
lib: @prisma+client                            3407    7.7%
lib: express                                   1809    4.1%
node core: node:_http_outgoing                 1054    2.4%

TOP FUNCTIONS BY SELF TIME
createPublicKey [keys]                        11242   25.5%
```

**`createPublicKey` -- 25.5% of all CPU.**

Hamare tokens **HS256** hain. HS256 ek symmetric HMAC hai. Is poore system mein
kahin koi public key hai hi nahi. Ye function is code path par hona hi nahi
chahiye tha.

### Root cause

`jsonwebtoken@9` ka `verify.js`:

```js
if (secretOrPublicKey != null && !(secretOrPublicKey instanceof KeyObject)) {
  try {
    secretOrPublicKey = createPublicKey(secretOrPublicKey);   // line 122
  } catch (_) {
    secretOrPublicKey = createSecretKey(Buffer.from(...));    // line 125
  }
}
```

Hum **string** pass kar rahe the. To har `jwt.verify` par:

1. `createPublicKey("dev-only-secret-...")` -- us string ko PEM/DER public key
   ki tarah parse karne ki koshish
2. fail -- aur fail ka matlab **exception throw + unwind**
3. catch -- phir `createSecretKey`, jo shuru se hi sahi raasta tha

Har ek authenticated request par ek exception banaya aur unwind kiya ja raha
tha, sirf ye pata karne ke liye jo code ko pehle se maloom tha.

### The fix

```ts
const jwtKey = createSecretKey(Buffer.from(config.auth.jwtSecret, 'utf8'));
// ... jwt.sign(claims, jwtKey, options)
// ... jwt.verify(token, jwtKey, { algorithms: ['HS256'], ... })
```

`instanceof KeyObject` ab true hai, to poora block skip.

**Measured (3 nodes, concurrency 20, 30s):**

| | before | after | change |
|---|---|---|---|
| rps | 173 | **241** | +39% |
| p50 | 101.72ms | **73.12ms** | -28% |
| p95 | 219.51ms | **158.38ms** | -28% |
| p99 | 308.69ms | **204.65ms** | -34% |

Ek profiled single node par asar aur saaf tha: **80 -> 218 rps (2.7x)**.

**Trade-offs:** koi nahi. Ye ek strictly better tareeka hai wahi kaam karne ka.
Behaviour bilkul same, security property bilkul same. Iski aakhri keemat sirf
ye thi ki koi ise dhoondhne ke liye profiler chalaye.

---

## 4. Decision 2: Cache the per-request user read

JWT fix ke baad dobara profile:

```
WHERE CPU GOES NOW                     ms   share
(idle)                              12202   29.1%
lib: @prisma+client                  6100   14.6%   <- ab sabse bada
lib: express                         3183    7.6%
node core: node:_http_outgoing       1926    4.6%
node core: node:internal/crypto/hash 1850    4.4%   <- ye asli HMAC hai, jaayaz
```

`createPublicKey` list se gaayab. Ab sabse bada Prisma hai, aur woh lagbhag
poora `findUserById` hai -- jo **har authenticated request** par chalta hai.

Pehle confirm kiya ki ye N+1 nahi hai: 1.75 transactions per request (thoda
noise ke saath ~1), yaani `include: { role, homeBranch }` alag-alag round trips
nahi bana raha. Ek hi query hai. Usse hatane ka matlab hai query **na karna**.

### Problem -> Options -> Chosen

**Problem.** Ek row jo din mein shayad do baar badalti hai, use har request par
padha ja raha hai.

**Par woh row ordinary nahi hai.** Usme user ki **current security state** hai:
`status`, `lockedUntil`, `roleId`, `passwordChangedAt`. Phase 4 ne jaan-bujh
kar ise per-request padha tha, taaki account disable karna **turant** asar kare,
token expiry par nahi.

| Option | Trade-off |
|---|---|
| A. Rehne do | Sahi, par sabse mehenga hissa bana rehta hai |
| B. Permissions ki tarah cache karo, 5 min TTL | Disable karne mein 5 minute lag sakte hain -- banking ke liye bahut lamba |
| C. Short TTL + har write path par explicit invalidation | Staleness sirf app ke BAHAR ke changes tak seemit |
| D. State ko JWT mein daal do | Phase 4 ne yahi reject kiya tha: staleness token lifetime ke barabar ho jaata hai, aur chhota karne ka koi tareeka nahi |

**Chosen: C -- 10 second TTL.**

**Why 10 and not 300.** "Humne disable kiya aur 10 second lage" aur "15 minute
lag sakte hain" -- ye do alag vaakya hain. Pehla operationally wahi hai jo
"turant" tha; doosra ek policy badalna hai.

**Why the real window is smaller.** Repository ke **har** write path par ab
`invalidateUser` hai:

```
updatePasswordHash    -> invalidateUser
recordSuccessfulLogin -> invalidateUser
recordFailedLogin     -> invalidateUser   <- ye sabse zaroori hai
```

`recordFailedLogin` `status` ko `LOCKED` kar sakta hai. Bina invalidation ke
account lockout 10 second ke liye **sirf salah** hoti, enforcement nahi.

To 10 second sirf tab lagte hain jab change application ke bahar hua ho -- DBA
ne haath se UPDATE chalaya, ya replica lag.

**Verified, guess nahi:**

```
1. repeated requests           -> 200 x5, redis key lc:user:<id> ttl=10s
2. in-app password change      -> old token 401 IMMEDIATELY (invalidation)
3. out-of-band UPDATE status   -> 200 immediately (cached copy, by design)
                                  401 after 12s   (the bound holds)
4. recordFailedLogin fired     -> redis EXISTS lc:user:<id> = 0 (invalidated)
```

### The trap this nearly walked into

`cached<T>` Redis mein `JSON.stringify` karta hai aur `JSON.parse` se wapas
padhta hai, phir **`as T` cast** kar deta hai.

JSON mein Date hota hi nahi. To cache HIT par aapko ISO **string** milti hai,
jabki type `Date` kehta hai -- aur compiler cast ki wajah se khushi se maan
jaata hai. **Ek jhootha type.**

Redis se seedha, is system se:

```
passwordChangedAt = '2026-09-22T07:45:51.880Z'   type=str
```

Aur `authenticate.ts` usi field par `.getTime()` bulata hai -- wahi Phase 4 ka
fix jo password change ke baad purane access token ko marta hai. Bina revival
ke cache hit par `.getTime is not a function` aata, aur woh security check
exception ban jaata.

Isliye `reviveUserDates` hai -- 11 date fields, User + Role + Branch teeno par,
haath se. Phase 6 ne business date ke liye bilkul yahi kiya tha; ye wahi
discipline ek security-critical field par.

**Measured:**

| | before | after | change |
|---|---|---|---|
| rps | 241 | **849** | +252% |
| p50 | 73.12ms | **22.08ms** | -70% |
| p95 | 158.38ms | **36.06ms** | -77% |
| p99 | 204.65ms | **46.54ms** | -77% |

Aur dependency load ka collapse:

```
              before      after
pgbouncer     41.7%   ->   2.7%
postgres     105.6%   ->  top-7 se bahar
```

---

## 5. Where the ceiling is now

Cache ke baad sweep flat ho gaya -- c=20 par 852, c=80 par 848. Flat curve ka
matlab aksar ye hota hai ki aap system nahi, apna **test harness** naap rahe ho.

Isliye load generator ko hi scale karke dekha:

```
ONE generator,   c=60        ->  873 rps   p50 64.91ms  p99 124.51ms
THREE generators, c=20 each  -> 1064 rps   p50 52.72ms  p99 123.14ms
                                 (354 + 354 + 356)
```

Same total concurrency, +22% throughput -- sirf generator badalne se. Yaani
**generator ceiling tha.**

Aur us 1064 rps par:

```
api-1 78.7%   api-2 80.6%   api-3 77.9%
nginx 41.9%   redis 15.1%   pgbouncer 2.7%
subtotal 302% of 1200% logical (~600% physical)
```

API nodes ~79% par hain, saturated nahi. **Asli capacity 1064 se zyada hai, aur
maine woh naapi nahi** -- iske liye ek behtar load generator chahiye (alag
machine, ya `autocannon`/`k6` jaisa tool jo Node ke single thread par na ho).

Phase 6 se pehle wahi generator 173 rps par server ko satura raha tha. Ab wahi
generator khud pehle mar jaata hai. Ye apne aap mein ek natija hai.

---

## 6. What can fail

### 6.1 Naapne ka tareeka hi galat ho

Sabse mehenga failure. Phase 8 ne ek sach measurement se ek galat conclusion
nikala, aur woh conclusion do phase tak chala. Fixed-concurrency load generator
capacity nahi naapta -- woh latency naapta hai.

Detect: sweep karo. Ek curve jhooth nahi bol sakti jaise ek point bol sakta hai.

### 6.2 Metric ko profiler samajh lena

`db_query_duration` ne 106ms bataya, Postgres ne 0.385ms. Dono sach. Metric
layer batata hai, function nahi.

Detect: jab metric aur uske neeche wali layer ka number match na kare, to beech
ka sab kuch suspect hai -- pool wait, IPC, serialization, event loop.

### 6.3 Flat throughput curve

Agar c=20 aur c=80 par rps same hai par latency 4x hai, to aap ek fixed ceiling
se takra rahe ho. Woh ceiling aapka client bhi ho sakta hai.

Detect: generator ko scale karo. Agar total rps badh gaya, ceiling aapka tha.

### 6.4 Cache mein Date

JSON mein Date nahi hota, aur `as T` cast compiler ki aankhon par patti baandh
deta hai. Ye chupchaap tab fail hota hai jab cache HIT ho -- yaani development
mein aksar theek chalta hai (miss) aur load par tootta hai (hit).

Detect: ek hi cheez do baar maango. Pehli miss hai, doosri hit.

### 6.5 Cache jo security state rakhta ho, bina invalidation ke

Sabse khatarnak cheez jo is phase mein add hui. `recordFailedLogin` par
invalidation na hoti to account lockout 10 second ke liye advisory ban jaata.

Aur note: mere pehle patch attempt mein ye teeno `invalidateUser` calls
**insert hi nahi huin** (string match fail ho gaya tha), aur **typecheck phir
bhi pass ho gaya**. Compiler ye nahi pakad sakta ki aap ek cache invalidate
karna bhool gaye. Sirf `grep` aur behaviour test ne pakda.

### 6.6 Optimisation jo behaviour badal de

JWT fix ne kuch nahi badla -- woh strictly better tha. User cache ne **badla**:
ek security property ab bounded staleness ke saath aati hai. Wahi cheez document
karni padti hai, aur wahi cheez interview mein poochhi jaati hai.

---

## 7. How to debug it

```bash
# Profile a node under load, in isolation
docker run -d --name lc-prof --network ledgercore_default -p 4099:4000 \
  --env-file prof.env --entrypoint /sbin/tini ledgercore-api:local -- \
  node --cpu-prof --cpu-prof-dir=/tmp/prof --cpu-prof-interval=200 dist/server.js
node scripts/load.mjs http://localhost:4099 prof 20 30000
docker stop -t 30 lc-prof          # graceful stop, or no profile is written
docker cp lc-prof:/tmp/prof ./prof

# Aggregate self time from the .cpuprofile: samples[] + timeDeltas[]
# (timeDeltas[i] is the time spent BEFORE samples[i])

# Where the layers disagree
docker exec ledgercore-api-1 wget -qO- http://127.0.0.1:4000/metrics \
  | grep -E "db_query_duration_seconds_(sum|count)|http_request_duration"
docker exec ledgercore-postgres psql -U ledgercore -d ledgercore \
  -c "EXPLAIN (ANALYZE, BUFFERS) <the query>"

# Is the event loop the problem?
... | grep nodejs_eventloop_lag

# Is the CLIENT the problem?
for i in 1 2 3; do node scripts/load.mjs http://localhost:8080 g$i 20 25000 & done; wait
# total rps higher than one generator alone => the generator was the ceiling

# Real cores, not logical
powershell -Command "Get-CimInstance Win32_Processor |
  Select Name,NumberOfCores,NumberOfLogicalProcessors"

# Cache behaviour (note the lc: namespace -- a scan for `user:*` finds nothing)
docker exec ledgercore-redis redis-cli --scan --pattern 'lc:user:*'
docker exec ledgercore-redis redis-cli ttl 'lc:user:<id>'
docker exec ledgercore-redis redis-cli get 'lc:user:<id>'
... | grep cache_operations_total
```

---

## 8. Interview questions

**Q1. Aapne performance kaise improve ki?**
Pehle naapa, phir badla. Do change, dono profiler se mile. Pehla: JWT secret ko
string ki jagah KeyObject banaya -- 25.5% CPU bachi. Doosra: per-request user
read ko 10 second TTL ke saath cache kiya. Mila kar 173 se 1,064 rps, p99 309ms
se 123ms. Dono changes code padh kar kabhi nahi milte, aur dono maujooda metrics
mein invisible the.

**Q2. `createPublicKey` wala bug detail mein.**
Profile mein 25.5% CPU `node:internal/crypto/keys` ke `createPublicKey` mein tha.
Hamare tokens HS256 hain -- symmetric HMAC, koi public key hai hi nahi. Wajah
jsonwebtoken 9 ka key handling hai: agar aap KeyObject nahi dete, to woh pehle
`createPublicKey` try karta hai, jo HMAC secret par PEM parse fail karke
**exception throw** karta hai, aur phir `createSecretKey` par girta hai. Yaani
har authenticated request par ek exception banaya aur unwind kiya ja raha tha,
sirf ye pata karne ko jo code ko pehle se maloom tha. `createSecretKey` ek baar
module load par bana diya; `instanceof KeyObject` check ne poora block skip kar
diya. 173 se 241 rps.

**Q3. Aapke metrics keh rahe the 93% waqt database mein ja raha hai. Sach tha?**
Nahi, aur dono numbers sach the -- yahi sikhne wali baat hai. `db_query_duration`
106ms bata raha tha; wahi query Postgres mein `EXPLAIN ANALYZE` par 0.385ms leti
thi. Metric Prisma ke extension mein maapa jaata hai, jo connection acquire,
Rust engine tak IPC, serialization, network -- sab ginta hai. Us 106ms mein
"database" 0.385ms tha. Aggregate metrics batate hain waqt kis LAYER mein gaya;
CPU kya kar raha hai, ye sirf profiler batata hai.

**Q4. Phase 8 mein aapne likha tha 3 nodes se throughput nahi badha. Woh sahi
tha?**
Nahi. Measurement sahi tha, conclusion galat. Load generator fixed concurrency
rakhta hai, aur Little's Law se `rps = concurrency / latency` -- fixed
concurrency par throughput badh hi nahi sakta jab tak latency na gire. Ek hi
point par dekhne se lagta hai kuch nahi badla. Sweep karne par 1 node vs 3 nodes
~1.5x nikla, 3x nahi -- aur 3x na hone ki wajah ye hai ki machine mein 6 physical
cores hain, 12 logical (SMT), aur Docker ka CPU% logical ginta hai. To "537% of
1200%" dekh kar headroom lagta hai jo asal mein nahi hai.

**Q5. Little's Law kya hai aur load testing mein kyun matter karta hai?**
`concurrency = throughput x latency`. Matter isliye karta hai ki load generators
do tarah ke hote hain: closed-loop (fixed concurrency) aur open-loop (fixed
arrival rate). Closed-loop par aap capacity naap hi nahi sakte -- system dheema
hone par aap khud dheere bhejne lagte ho, aur numbers accha dikhte hain jabki
asli users queue mein khade hote. Capacity dekhni ho to ya concurrency sweep
karo aur knee dhoondho, ya open-loop generator use karo.

**Q6. Aapne user lookup cache kiya jo security state rakhta hai. Ye safe kaise
hai?**
Safe hone ka pura bojh invalidation par hai, TTL par nahi. Repository ke har
write path par `invalidateUser` hai -- khaas kar `recordFailedLogin`, jo status
LOCKED kar sakta hai; bina uske lockout 10 second ke liye sirf salah hota,
enforcement nahi. TTL sirf application ke BAHAR hue changes ko bound karta hai,
aur 10 second isliye chuna ki "disable karke 10 second" operationally wahi hai
jo "turant" tha, jabki 5 minute ek policy badalna hota. Maine dono raaste
verify kiye: in-app password change se purana token turant 401 hua, aur seedha
SQL UPDATE se disable karne par 12 second baad 401.

**Q7. Cache mein Date ka kya masla hai?**
JSON mein Date type hota hi nahi. `JSON.stringify` use ISO string bana deta hai
aur `JSON.parse` use string hi rakhta hai. Aur hamara `cached<T>` `as T` cast
karta hai, to TypeScript kehta rahega ki woh `Date` hai jabki runtime par
`string` hai -- ek jhootha type jise compiler pakad hi nahi sakta. Hamare case
mein `authenticate.ts` us field par `.getTime()` bulata hai, jo Phase 4 ka token
invalidation check hai -- to cache hit par woh security check exception ban
jaata. Isliye 11 date fields haath se revive kiye jaate hain. Ye chupchaap
sirf HIT par fail hota, yaani development mein theek aur load par kharab.

**Q8. Ab bottleneck kahan hai?**
Server par nahi. 1,064 rps par API nodes ~79% CPU par the, pgBouncer 2.7% par,
Postgres top-7 se bahar. Ceiling load generator tha -- ek Node process. Teen
generators chala kar, same total concurrency par, 873 se 1,064 rps ho gaya.
Yaani asli capacity 1,064 se upar hai aur **maine woh naapi nahi**; uske liye
alag machine se, ya k6/autocannon jaise tool se testing chahiye. Phase 6 se
pehle yahi generator 173 rps par server ko satura raha tha; ab woh khud pehle
marta hai.

**Q9. N+1 query kaise dhoondhi?**
Prisma ke per-operation counters se: `User.findUnique` 2,807 baar chala 2,792
HTTP requests ke liye -- lagbhag 1:1, yaani `include` extra round trips nahi
bana raha tha. Cross-check Postgres ke apne counters se kiya: 20 requests ke
liye transactions ginin, ~1.75 per request mile. Agar `include` teen alag
queries banata to ye 3x hota. N+1 hoti to yahi do numbers use turant dikha
dete.

**Q10. Ek optimisation jo aapne NAHI ki, aur kyun?**
Retry ke aage delay wali baat Phase 13 mein thi, par yahan ka jawab alag hai:
maine `findUserByStaffCode` cache nahi kiya. Woh sirf login par chalta hai, aur
login par scrypt waise bhi jaan-bujh kar mehenga hai -- wahan ek DB read bachane
se kuch nahi milta, aur ek aur cache key invalidate karne ke liye aa jaati.
Optimise wahi karo jo per-request path par hai; baaki sirf surface area badhata
hai.

---

## 9. Honest gaps

- **Asli maximum capacity naapi nahi gayi.** 1,064 rps par test harness ceiling
  tha, system nahi. Iske liye alag machine se load chahiye.
- **Sirf ek endpoint optimise hua** -- `GET /auth/me`, kyunki wahi load script
  chalata hai. Posting path (`POST /vouchers`) profile nahi hua, aur woh CPU ka
  alag shape rakhta hai (money math, locking, outbox write).
- **Load generator closed-loop hai.** Sweep se knee mil jaati hai, par ek
  open-loop generator (fixed arrival rate) saturation ke baad ka behaviour
  zyada imaandaari se dikhata.
- **`pg_stat_statements` enabled nahi hai** -- query-level analysis
  `pg_stat_database` counters aur haath se `EXPLAIN` par ho rahi hai. Terraform
  mein woh parameter likha hai, par woh stack kabhi deploy nahi hui.
- **Sab kuch ek developer machine par**, jispar Windows, Docker Desktop aur ek
  alag Supabase stack bhi chal raha tha. Numbers relative comparison ke liye
  hain (before/after, 1 node vs 3), absolute capacity ke liye nahi.
- **10 second staleness window** ab ek documented security property hai. Ek asli
  bank mein ye compliance review se guzarti, mere faisle se nahi.

---

## 10. Measured summary

| Stage | rps | p50 | p95 | p99 |
|---|---|---|---|---|
| Baseline (3 nodes, c=20) | 173 | 101.72ms | 219.51ms | 308.69ms |
| After JWT KeyObject | **241** | 73.12ms | 158.38ms | 204.65ms |
| After user cache | **849** | 22.08ms | 36.06ms | 46.54ms |
| 3 load generators (c=60 total) | **1,064** | 52.72ms | -- | 123.14ms |

| Other | Before | After |
|---|---|---|
| Single node (profiled) | 80 rps | **218 rps** |
| pgBouncer CPU at load | 41.7% | **2.7%** |
| Postgres CPU at load | 105.6% | out of top 7 |
| `createPublicKey` share of CPU | **25.5%** | 0 |
| 1 node vs 3 nodes | claimed "no gain" | **~1.5x**, measured across 5 concurrency levels |

Overall: **6.1x throughput, p99 2.5x better**, from two changes totalling about
twenty lines -- neither of which was findable without a profiler.
