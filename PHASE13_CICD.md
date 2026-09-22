# Phase 13 -- CI/CD and Deployment Strategies

Status: complete. The pipeline is green on real GitHub Actions runners, not
described. Every number below was measured.

Repository: https://github.com/sonuengineer/AML_ledgercore

---

## 1. What we built

1. A **git repository** for the project, with a fail-closed `.gitignore`.
2. A **CI pipeline** at `.github/workflows/ci.yml` -- 7 jobs, two independent
   chains, running on every push and pull request.
3. **Image hygiene assertions** in CI, so the Phase 12 work is re-proved on
   every push rather than trusted.
4. **Measured deployment strategies**: naive vs rolling, canary, blue-green,
   rollback.
5. A fix for a rare production-class bug the deployment experiments exposed.

Hinglish: is phase ka asli natija ye nahi hai ki "ek YAML file likh di". Asli
natija ye hai ki pipeline **chali**, aur chalte hi usne char aise bug nikal diye
jo mahino se code mein baithe the aur kisi ko dikh nahi rahe the.

---

## 2. Why we built it (the decisions)

### Decision 1: Repository scope -- allowlist, not denylist

**Problem.** `H:\fin` sirf naya project nahi hai. Usi directory mein legacy .NET
backend aur React frontends bhi hain (`Backend/`, `CoreLibraries/`, `DataModel/`,
`FinCoreMainNew/`, `Frontend/`, `Fin_Connect_Cms_React/`, `ib-admin-portal-ui/`,
`New_fin/`, `AML-*/`). Woh proprietary code hai, aur **repo PUBLIC hai**.

**Options.**

| Option | Trade-off |
|---|---|
| A. Denylist (`node_modules`, `.env`, `Backend/` ...) | **Fails open.** Jo cheez kisi ne socha hi nahi, woh commit ho jaati hai |
| B. Naye project ko alag directory mein move karo | Sahi hai, lekin bada filesystem reorganisation, aur compose ke relative paths tootenge |
| C. Allowlist: sab ignore, phir sirf zaroori cheezein wapas | **Fails closed.** Jo socha nahi gaya woh ignore rehta hai |

**Chosen: C.**

```gitignore
/*
!/.gitignore
!/.github/
!/ledgercore/
!/ledgercore-web/
!/README.md
!/PHASE2_ARCHITECTURE.md
... (per-file)
```

**Why.** Public repo jiska parent directory proprietary source share karta ho --
wahan fail-closed ke alawa koi defensible choice hai hi nahi.

Aur ise **verify** kiya gaya, maana nahi gaya. Push se pehle:

```
files staged: 171   size: 1.0 MB
[OK] Backend excluded      [OK] Frontend excluded      [OK] New_fin excluded
[OK] CoreLibraries excluded [OK] Fin_Connect_Cms_React excluded
[OK] DataModel excluded    [OK] ib-admin-portal-ui excluded
[OK] FinCoreMainNew excluded [OK] AML- excluded  [OK] node_modules excluded
secret sweep (AWS keys / private keys / GitHub tokens): none
.env staged: only .env.example
```

Ek gap sweep ne hi pakda: `ledgercore-web/.gitignore` sirf `.env.local` ignore
karta tha, `.env` nahi -- woh staged ho raha tha. Fix karke re-verify kiya.

**Trade-off.** Nayi top-level file add karne par `.gitignore` mein bhi entry
karni padegi, warna woh chupchaap ignore rahegi. Ye deliberate ghisai hai --
galti ki disha "commit nahi hua" ki taraf rakhi gayi hai, "leak ho gaya" ki
taraf nahi.

### Decision 2: Serial chain within a project, parallel chains across projects

```
api-typecheck -> api-test -> api-build -> api-integration -> api-docker
web-build -----------------------------------------------> web-docker
```

**Why serial inside the API chain.** Sabse sasti aur sabse specific failure
pehle dikhni chahiye. Type error "typecheck failed" ke roop mein 25 second mein
aana chahiye, na ki "integration tests failed" ke roop mein aath minute baad, ek
aise Postgres ke peeche jo boot hona tha.

**Why parallel across projects.** Ye Phase 12 ka decision executable ban gaya:
do artefacts, do lifecycles. CSS change ledger ke integration tests ka intezaar
nahi karega.

**Trade-off.** Green run fan-out se dheema hai. Manzoor hai -- aap jo run padh
rahe hote ho woh lagbhag hamesha red hoti hai.

### Decision 3: Image hygiene ko assertion banao, bharosa nahi

Phase 12 ne 373 MB -> 292 MB kiya, npm hataya, ek hi Prisma engine chhoda. Lekin
Phase 12 mein hi ye bhi hua tha ki **Dockerfile fix ho gaya jabki compose jo tag
use karta hai woh 42 minute purana raha**.

To CI ab har push par ye assert karti hai:

```
--- exactly one Prisma query engine ---   engines: 1
--- no schema-engine in a serving image ---
--- no package manager in the runtime ---
--- does not run as root ---              user: node
```

**Why.** Ek sudhaar jo sirf documentation mein hai, woh regression se ek commit
door hai. Assertion use theek us jagah pakadti hai jahan woh toota.

---

## 3. How it works -- and what the first run found

**Ye is phase ka sabse zaroori hissa hai.**

Pipeline ka pehla asli execution `git push` ke baad hua. Usse pehle woh file
review ho chuki thi, likhi ja chuki thi, aur us par bharosa tha. Usne char bug
nikale. Ek bhi bug aisa nahi tha jo padh kar dikh jaata.

### Bug 1: Workflow aisi jagah tha jahan se woh kabhi chalta hi nahi

File `ledgercore/.github/workflows/ci.yml` par thi.

GitHub Actions workflows **sirf** `<repo-root>/.github/workflows/` se padhta
hai. Subdirectory ke andar `.github` sirf ek folder hai.

Yaani Phase 12 tak jo "CI pipeline" maani ja rahi thi, woh ek document thi,
guarantee nahi. Root par le jaaya gaya, har job ko apni `working-directory` aur
`cache-dependency-path` di gayi.

**Sabak:** jis pipeline ko aapne chalte hue dekha nahi, woh pipeline nahi hai.

### Bug 2: Unit tests ek gitignored file ke sahaare pass ho rahe the

```
api / unit tests: FAILED
Error: process.exit unexpectedly called with "1"
  src/config/index.ts:97
  src/shared/logging/logger.ts:2
```

Chain: `resilience.test.ts` -> circuit breaker -> logger -> config. Config zod se
`process.env` validate karta hai aur `DATABASE_URL` / `JWT_SECRET` na milne par
`process.exit(1)` karta hai.

Locally pass isliye hota tha kyunki **Vitest disk par padi `.env` ko
`process.env` mein load kar deta hai** -- aur `.env` gitignored hai. Yaani suite
ki "runnable anywhere" wali baat ek untracked file ke sahaare khadi thi. Fresh
clone bhi bilkul aise hi fail hota.

Fix: `vitest.config.ts` mein `test.env` declare kiya, jaan-bujh kar unusable
values ke saath (`localhost:1`), taaki agar koi unit test kabhi sach mein
database tak pahuncha to woh **zor se fail ho**, chupchaap kisi asli DB se connect
na ho jaaye.

Iska ek sub-bug bhi mila: pehli koshish mein maine `LOG_LEVEL: 'silent'` diya,
jo zod enum (`fatal|error|warn|info|debug|trace`) mein hai hi nahi. Config ne use
reject karke wahi `exit(1)` kiya -- **bilkul wahi stack trace** jo original bug
ka tha. Aisi soorat mein aasani se lagta hai "fix apply hi nahi hua". Apply hua
tha; galat tha. Sahi wajah stderr par likhi hui thi.

**Sabak:** CI ka sabse bada fayda speed nahi hai. Ye hai ki CI **har baar ek
fresh clone hota hai**, aur isliye woh aapke laptop ki chhupi hui state ke baare
mein imaandaar hai.

### Bug 3: Migration chain fresh database par replay hi nahi hoti thi

```
Error: P3018  A migration failed to apply.
Database error code: 42704
ERROR: index "customer_full_name_trgm_idx" does not exist
```

Khaali database par sequence:

```
phase5_ledger               CREATE INDEX customer_full_name_trgm_idx
phase5_voucher_list_index   DROP INDEX   customer_full_name_trgm_idx
phase7_aml_and_dead_letters DROP INDEX   customer_full_name_trgm_idx   <- 42704
restore_handwritten_objects CREATE INDEX IF NOT EXISTS ...             <- kabhi
                                                                          pahuncha
                                                                          hi nahi
```

Doosra DROP `prisma migrate diff` wale us bug se aaya jo PHASE7_ASYNC.md mein
likha hai.

Locally kabhi fail nahi hua kyunki jab ye migration pehli baar apply hui thi tab
index maujood tha -- ek ad-hoc EXPLAIN script ne use haath se recreate kar diya
tha. **Yaani developer database sirf apne aap se reproducible tha.**

Ye ek deployment bug hai, test bug nahi: har naya environment -- staging, prod,
DR restore, naya joiner ka laptop -- deploy par yahi fail karta.

Fix: `DROP INDEX IF EXISTS`. Applied migration edit karna normally mana hai;
yahan lesser evil tha, kyunki use exactly **ek** database ne apply kiya tha aur
har future environment warna fail hota. Verify kiya ki maujooda local DB par
`migrate deploy` par koi asar nahi (Prisma applied migrations ke checksum verify
nahi karta).

Proof, ek throwaway database mein poora chain replay karke:

```
All migrations have been successfully applied.   (9 migrations)
indexes present afterwards:
  account_title_trgm_idx
  customer_full_name_trgm_idx
```

### Bug 4: CI aadha data seed kar rahi thi

```
All 18 ledger tests + 2 chaos tests FAILED
"An operation failed because it depends on one or more records that were
 required but not found."
```

`pnpm db:seed` sirf branches, staff aur roles banata hai. Ledger suite ko chart
of accounts chahiye (`db:seed:ledger`), AML ko uske rules (`db:seed:aml`).
Locally ye mahino pehle haath se chal chuke the, to zaroori sequence sirf
developer ke **dimaag** mein thi.

Fix: `db:seed:all` -- sequence ek jagah likh di, taaki CI aur laptop kabhi
divergent na ho.

### Green

```
web / typecheck + build   success    17s
api / typecheck           success    25s
web / docker build        success    21s
api / unit tests          success    15s
api / build               success    23s
api / integration tests   success    44s
api / docker build        success    75s
```

Ek aur cheez raaste mein mili, jo product bug nahi tha: local par
`queue.int.test.ts` timeout ho raha tha, kyunki compose ka `worker` container usi
queue Redis se jobs utha raha tha -- ek competing consumer. Use rokte hi 12/12.
CI mein ye kabhi nahi hota, kyunki uske service containers per-run isolated hain.
README mein likh diya gaya hai.

---

## 4. Deployment strategies -- measured, not described

Sab kuch `docker compose --profile scale` topology par: nginx + api-1/2/3 +
pgBouncer, aur `scripts/load.mjs` se live load (concurrency 20).

### 4.1 Naive deploy -- sab ek saath

```
docker compose restart api-1 api-2 api-3     (t = 12s, load chalte hue)
```

```
requests  3,642
errors   15,348          <- 81% of attempts
rps          81
```

Teeno nodes ek saath drain hue, ek saath listening band ki, aur poora fleet ~18
second ke liye gayab ho gaya. nginx ke paas bhejne ke liye koi upstream nahi
bacha.

### 4.2 Rolling deploy -- ek node, healthy hone ka intezaar, phir agla

```
for n in api-1 api-2 api-3:
    recreate n
    wait until its /readiness healthcheck says healthy
```

```
api-1 rotated and healthy again after 40s
api-2 rotated and healthy again after 23s
api-3 rotated and healthy again after 25s

requests  16,883
errors         0          <- zero
rps          141
p50/p95/p99   116 / 357 / 521 ms
distribution  api-1 5721  api-2 5478  api-3 5684
```

| | Naive | Rolling |
|---|---|---|
| Errors | **15,348** | **0** |
| Deploy duration | ~18s | ~88s |

**Ye zero muft nahi mila.** Teen cheezein pehle se honi zaroori thin, aur teeno
pichhle phases mein bani thin:

1. **Graceful drain (Phase 3).** Node pehle `/readiness` ko 503 karta hai, 10
   second traffic nikalne deta hai, *phir* listening band karta hai. Exit code 0,
   137 nahi.
2. **`proxy_next_upstream error timeout` (Phase 8).** Jo request ek marte hue
   node par chali gayi, nginx use doosre node par retry karta hai. nginx ke error
   log mein `connect() failed (111: Connection refused)` dikha -- aur client ko
   phir bhi 0 errors mile. Wahi retry kaam kar raha tha.
3. **Statelessness (Phase 8).** Sessions, rate-limit counters, idempotency records
   -- sab Postgres/Redis mein, kisi node ki memory mein nahi. Isliye node ko
   maarna kisi ka session nahi todta.

**Interview line:** "rolling deploy" ek deploy script ka naam nahi hai. Woh teen
cheezon ka natija hai -- readiness, upstream retry, aur statelessness. Inme se
ek bhi na ho, to rolling deploy bas dheema naive deploy hai.

### 4.3 Canary -- nginx weights

```nginx
server api-1:4000 weight=9;
server api-2:4000 weight=9;
server api-3:4000 weight=1;    # canary: 1/19 = 5.3%
```

`nginx -s reload` -- restart nahi, connection drop nahi.

```
requests 4,158   errors 0
api-1   1971   47.4%
api-2   1966   47.3%
api-3    221    5.3%      <- expected 1/19 = 5.3%
```

**Why canary.** Rolling deploy poore fleet ko naya version de deta hai, bas
dheere. Agar naya version kharab hai to 100% users ko milta hai, thoda der se.
Canary usko 5% par rok deta hai.

**Par canary ka asli hissa weights nahi hai.** Asli hissa ye hai ki aap canary ko
**alag se dekh paayein**. Phase 9 ke metrics par har series mein `instance` label
hai, to `rate(http_errors_total{instance="api-3"}[5m])` baaki do se compare ho
sakta hai. Bina per-instance observability ke canary sirf "kam logon ko toda" hai
-- ek detection mechanism nahi.

### 4.4 Blue-green -- do fleets, ek switch

```nginx
upstream ledgercore_api       { server api-1:4000; server api-2:4000; }  # blue
upstream ledgercore_api_green { server api-3:4000; }                     # green
```

Cutover = `proxy_pass` badlo aur reload karo.

```
blue        errors=3    api-1: 843, api-2: 833
  cutover 1637ms
green       errors=0    api-3: 1562          <- 100% shifted
  rollback  759ms
rolled back errors=0    api-1: 874, api-2: 866
```

**Rollback 759 milliseconds mein.** Yahi blue-green ka poora point hai: purana
version zinda khada rehta hai, to rollback ek config switch hai, redeploy nahi.

**Trade-off, aur ye bada hai:** blue-green ko doguni capacity chahiye. Aur database
usme shaamil nahi hai -- woh dono ke beech shared rehta hai. Isliye koi bhi
migration **backward compatible** honi chahiye, warna green ka schema blue ko tod
dega aur rollback ka raasta band ho jaayega. Ye expand-migrate-contract pattern
hai: pehle column add karo (dono versions chalein), phir backfill, phir jab
purana version retire ho jaaye tab purana column hatao.

**Honest note:** yahan blue = 2 nodes, green = 1 node hai. Asli blue-green mein
dono ki capacity barabar hoti hai. Mechanism sahi demonstrate hua hai; capacity
symmetry nahi.

### 4.5 Kaunsa kab

| Strategy | Kab | Cost |
|---|---|---|
| Rolling | Default. Routine changes | Deploy ke dauraan capacity thodi kam; dono versions ek saath chalte hain |
| Canary | Risky change, naya query path, naya dependency | Dheema; per-instance metrics chahiye |
| Blue-green | Jahan rollback seconds mein chahiye | Doguni capacity; DB shared rehta hai |

Teeno ke liye ek hi shart common hai: **image immutable digest/sha se tag ho**.
`latest` par rollback ka koi matlab nahi hota -- woh ek chalti hui pointer hai,
koi version nahi.

---

## 5. What can fail

### 5.1 Ek pipeline jo kabhi chali nahi

Sabse khatarnak wahi hai, kyunki woh **green dikhti hai** -- aur actually kuch
dikhati hi nahi, kyunki chalti hi nahi. Bug 1 exactly yahi tha.

Detect: `gh run list`. Agar repo mein workflow hai par runs nahi hain, to woh
workflow exist nahi karta.

### 5.2 Test jo aapke laptop ki state par nirbhar hai

`.env`, haath se seed kiya hua data, haath se bana index, ek background process
jo chal raha hai. Bug 2, Bug 3 aur Bug 4 -- teeno isi family ke hain.

Detect: `git stash -u` se untracked cheezein hata kar chalao. Ya container mein
fresh clone karke chalao. Ya bas CI chalne do -- woh yahi karta hai, har baar.

### 5.3 Migration jo replay nahi hoti

Har environment isi chain se banta hai. Agar chain khaali database par nahi
chalti, to aapka database sirf apne aap se reproducible hai.

Detect: CI mein har run par fresh Postgres par `migrate deploy` -- jo ab hota hai.

### 5.4 Deploy jisme koi drain nahi

Graceful shutdown ke bina rolling deploy sirf dheema naive deploy hai. Aapko
kam errors milenge, zero nahi.

### 5.5 Canary bina per-instance metrics

Aggregated dashboard par 5% canary ka 100% error rate poore fleet ke 5% error
rate jaisa dikhega -- yaani noise. Aap use dekh hi nahi paoge.

### 5.6 Blue-green jiski migration backward compatible nahi

Cutover chal jaayega. Rollback nahi chalega, kyunki purana code naye schema ko
nahi padh sakta. Ye blue-green ka sabse mehenga failure mode hai, kyunki aapne
paisa exactly us rollback ke liye diya tha jo ab available nahi hai.

### 5.7 Stale pooled connection (jo in experiments ne khola)

Blue-green experiment ke dauraan: **~31,000 requests mein 6 HTTP 500**, yaani
0.019%. Saare `prisma.user.findUnique()` authenticate middleware ke andar, saare
`"Server has closed the connection"`.

Prisma apna connection pool pgBouncer tak rakhta hai; pgBouncer unhe neeche se
recycle karta hai. To client ek aisa handle utha sakta hai jise woh abhi bhi
zinda maanta hai.

Fix likha gaya: **sirf read operations** ke liye ek baar retry, plus
`db_connection_retries_total{outcome}` counter.

Reads only kyun -- ye poori safety argument hai. `"Server has closed the
connection"` **ambiguous** hai: ho sakta hai statement Postgres tak pahuncha hi
na ho, ya pahuncha ho, commit ho gaya ho, aur sirf acknowledgement raaste mein
kho gaya ho. Error se ye pata karne ka koi tareeka nahi. Is ambiguity mein read
retry karna muft hai -- worst case wahi rows dobara padh li. **Write** retry
karna ek voucher do baar post kar sakta hai -- theek wahi ek failure jise rokne
ke liye ye poora system bana hai. Isliye writes jaan-bujh kar fail hone diye jaate
hain; unke paas Phase 10 ki idempotency key pehle se hai, jahan unique constraint
faisla karta hai, andaaza nahi.

**Aur ab imaandaar hissa: ye retry kabhi recover karte hue dekha nahi gaya.**

```
experiment 1: pgBouncer restart under load       16 retries, 16 failed
experiment 2: pgBouncer KILL/RESUME under load   15 retries, 15 failed
experiment 3: same, with a 25ms pre-retry pause  19 retries, 19 failed
                                        total:   46 retries,  0 recovered
```

Wajah saaf hai: bahar se jo bhi failure force ki ja sakti hai woh **poore pool ko
ek saath** maar deti hai, to retry ko bhi ek aur mara hua handle hi milta hai.
Woh ek dependency outage hai, aur us haalat mein ye code sahi kaam karta hai --
usse chhupata nahi. Jungle mein jo bug dikha woh **ek** recycled connection ka
tha jabki baaki nau theek the, aur use on-demand reproduce karne ka tareeka abhi
tak nahi mila.

Retry rakha gaya hai kyunki woh muft hai aur kuch bigaad nahi sakta -- reads only,
ek attempt, koi delay nahi. Lekin woh is sabut par nahi rakha gaya ki woh kaam
karta hai. Counter hi is sawaal ka faisla karega: agar asli deployment mein
`recovered` zero hi raha, to ise delete kar dena chahiye.

Experiment 3 ka 25ms pause **hata diya gaya**. Woh is theory par add kiya tha ki
pool ko turn over hone ke liye ek lamha chahiye; measurement ne theory galat
sabit kar di. Bina naape fayde ke latency ship karna trade nahi hai, sirf cost
hai.

---

## 6. How to debug it

```bash
# Pipeline
gh run list --limit 5
gh run view <id> --json jobs -q '.jobs[] | "\(.name)\t\(.conclusion)"'
gh run view <id> --log-failed
gh run watch <id> --exit-status

# Workflow ko push kiye bina validate karo (YAML + action inputs + shellcheck)
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest

# "Ye mere laptop par chalta hai" ko reproduce karo
cd ledgercore
mv .env .env.bak && pnpm test; mv .env.bak .env     # fresh-clone condition

# Migration chain fresh DB par replay hoti hai?
docker exec ledgercore-postgres psql -U ledgercore -d postgres \
  -c "CREATE DATABASE replay_check;"
DATABASE_URL="postgresql://ledgercore:ledgercore@localhost:5432/replay_check?schema=public" \
  pnpm exec prisma migrate deploy

# Deploy ke dauraan kya hua
node scripts/load.mjs http://localhost:8080 label 20 60000
docker logs ledgercore-nginx | grep -v "status=200"
docker logs ledgercore-api-1 | grep '"level":"error"'

# Traffic split / canary
docker exec ledgercore-nginx nginx -t        # ALWAYS before reload
docker exec ledgercore-nginx nginx -s reload

# Stale connection counter
docker exec ledgercore-api-1 wget -qO- http://127.0.0.1:4000/metrics \
  | grep db_connection_retries_total
```

---

## 7. Interview questions

**Q1. Aapki CI pipeline mein kya hai?**
Saat jobs, do independent chains. API chain serial hai -- typecheck, unit tests,
build, integration (Postgres + dono Redis roles service containers ke roop mein),
docker build with hygiene assertions. Web chain parallel chalti hai, kyunki woh
alag artefact hai jiska apna lifecycle hai. Serial isliye taaki sabse sasti aur
sabse specific failure pehle dikhe: type error 25 second mein "typecheck failed"
banna chahiye, aath minute baad "integration tests failed" nahi.

**Q2. Aapki pipeline ne pehli baar chalne par kya pakda?**
Char bug, aur yahi is phase ka asli jawab hai. Workflow subdirectory mein tha to
woh kabhi chalta hi nahi tha. Unit tests ek gitignored `.env` ke sahaare pass ho
rahe the. Migration chain khaali database par replay hi nahi hoti thi -- P3018.
Aur CI sirf aadha dataset seed kar rahi thi, kyunki poora seed sequence sirf mere
dimaag mein tha. Teen ka common root cause ek hi hai: local environment mein
haath se bani hui state, jo kisi commit mein nahi thi.

**Q3. Migration wala bug detail mein batao.**
Ek index phase 5 mein banaya gaya, phir usi phase ki agli migration ne use drop
kar diya -- woh `prisma migrate diff` ka bug tha. Phase 7 ki migration ne use
dobara drop kiya. Fresh database par teesra step 42704 ke saath marta hai, kyunki
index pehle hi ja chuka hai, aur chain wahin ruk jaati hai -- usse agli migration,
jo indexes wapas banati thi, kabhi chalti hi nahi. Locally fail nahi hua kyunki
jab woh migration pehli baar apply hui thi tab index maujood tha: ek ad-hoc
EXPLAIN script ne use haath se bana diya tha. Yaani mera dev database sirf apne
aap se reproducible tha. Ye test problem nahi, deployment problem hai -- har naya
environment deploy par fail karta.

**Q4. Applied migration edit karna to mana hai. Aapne kyun kiya?**
Kiya, aur ye lesser evil tha. Use exactly ek database ne apply kiya tha -- mera
dev DB -- aur har future environment warna deploy par fail hota. Agar prod mein
apply ho chuki hoti to jawab alag hota: aap ek naya forward migration likhte aur
fresh installs ke liye baseline/squash karte. Maine verify bhi kiya ki maujooda
DB par `migrate deploy` par koi asar nahi padta, aur fix ko ek throwaway database
mein poora chain replay karke prove kiya.

**Q5. Rolling deploy se downtime kaise zero hua? Naap ke dikhao.**
Naapa hai. Live load ke neeche teeno nodes ek saath restart karne par 15,348
errors mile. Wahi teen nodes ek-ek karke, har ek ke healthy hone ka intezaar
karke, 0 errors -- 16,883 requests par. Lekin zero muft nahi tha. Teen cheezein
pehle se chahiye thin: graceful drain, jisme node pehle readiness 503 karta hai
aur phir listening band karta hai; nginx par `proxy_next_upstream error timeout`,
jisne ek marte hue node par gayi requests doosre node par retry kar di -- uske
error log mein connection refused dikha aur client ko phir bhi 0 errors mile; aur
statelessness, kyunki sessions aur rate-limit counters Postgres/Redis mein hain,
node ki memory mein nahi. Inme se ek bhi na ho to rolling deploy sirf dheema
naive deploy hai.

**Q6. Rolling, blue-green aur canary mein farak?**
Rolling poore fleet ko naya version deta hai, bas dheere -- kharab version phir
bhi 100% users tak pahunchta hai, thodi der se. Canary use 5% par rokta hai, par
uski asli shart weights nahi hai, per-instance observability hai: agar aap canary
ko alag se measure nahi kar sakte to aapne sirf kam logon ko toda hai, detect
kuch nahi kiya. Blue-green rollback ke liye hai -- purana fleet zinda khada
rehta hai, to wapas jaana ek config switch hai. Maine cutover 1637ms aur rollback
759ms naapa, dono par 0 errors. Cost doguni capacity hai.

**Q7. Blue-green mein database ka kya hota hai?**
Database switch nahi hota -- wahi ek shared rehta hai. Isliye har migration
backward compatible honi chahiye, warna green ka schema blue ko tod dega aur
rollback ka raasta band ho jaayega -- jo ki blue-green ka poora maqsad tha.
Practically iska matlab expand-migrate-contract hai: pehle nullable column add
karo taaki dono versions chal sakein, phir backfill karo, aur purana column tabhi
hatao jab purana version retire ho chuka ho. Sabse mehenga failure mode yahi
hai, kyunki aapne paisa theek us rollback ke liye diya tha jo ab available nahi.

**Q8. Rollback kaise karoge?**
Image ko commit sha se tag karke, kabhi sirf `latest` se nahi. `latest` ek chalti
hui pointer hai, version nahi -- "latest par rollback karo" ek aisa vaakya hai
jiska koi matlab nahi. Immutable tag ke saath rollback wahi rolling deploy hai,
bas purane digest ke saath. Blue-green mein woh aur tez hai: proxy switch, 759ms.
Database migration rollback alag aur mushkil sawaal hai -- isi liye migrations
backward compatible rakhi jaati hain, taaki code rollback ke liye DB rollback
zaroori hi na ho.

**Q9. CI mein secrets kaise handle karoge?**
Abhi kuch push nahi hota, to koi registry credential nahi chahiye. Jab ECR
aayega, `aws-actions/configure-aws-credentials` **OIDC** ke saath -- yaani
long-lived AWS keys GitHub secrets mein rakhne hi nahi padenge; workflow ek
short-lived token exchange karta hai. Workflow mein `permissions: contents: read`
already set hai, aur OIDC ke liye job level par `id-token: write` chahiye hoga.
Integration job ka JWT_SECRET ek CI-only placeholder hai, aur woh 32 chars se
lamba hai kyunki config validation isse chhota reject karke boot par hi mar
jaata.

**Q10. Ek aisa bug bataiye jo aapko lagta tha aapne fix kar diya, par nahi kiya
tha.**
Do hain. Pehla: unit test fix karte waqt maine `LOG_LEVEL: 'silent'` diya, jo zod
enum mein hai hi nahi. Config ne use reject karke wahi `process.exit(1)` kiya --
bilkul wahi stack trace jo original bug ka tha. Do minute mujhe laga fix apply hi
nahi hua. Apply hua tha, galat tha, aur sahi wajah stderr par pehle se likhi thi.
Doosra zyada important hai: maine stale pooled connection ke liye retry likha,
phir use prove karne ki teen koshishein kin -- 46 retries, 0 recovered. Har woh
failure jo main bahar se force kar sakta tha poore pool ko ek saath maar deti hai,
jo ki ek alag failure mode hai. Maine retry rakha, kyunki woh muft hai aur kuch
bigaad nahi sakta, lekin doc mein saaf likha ki woh unproven hai, aur ek 25ms
delay jo maine theory par add kiya tha woh hata diya kyunki measurement ne theory
galat sabit kar di. Bina naape fayde ke latency ship karna trade nahi, cost hai.

---

## 8. Honest gaps

- **Kuch push nahi hota.** Koi registry nahi, koi ECR nahi, koi OIDC role nahi.
  Terraform kabhi apply nahi hui, to image publish karna ek daawa hota, deploy
  nahi. Workflow mein exact ECR block comment ke roop mein likha hai.
- **Rolling/canary/blue-green docker compose par demonstrate hue hain, ECS ya
  k8s par nahi.** Mechanism wahi hai (readiness gate, weighted routing, traffic
  switch), lekin ECS deployment circuit breaker ya k8s `maxSurge/maxUnavailable`
  chalaye nahi gaye.
- **Blue-green asymmetric tha** -- blue 2 nodes, green 1 node.
- **Koi eslint nahi.** Ye Phase 9 se carried gap hai aur abhi bhi khula hai;
  pipeline mein lint gate isliye nahi hai.
- **Stale-connection retry unproven hai** (section 5.7).
- **Kuch automated rollback nahi** -- rollback manually chalaya gaya aur naapa
  gaya; koi pipeline stage error rate dekh kar khud rollback nahi karta.
- **Deprecation warning**: `actions/checkout@v4`, `setup-node@v4`,
  `pnpm/action-setup@v4` Node 20 target karte hain aur runner unhe Node 24 par
  force kar raha hai. Abhi warning hai, aage badh kar failure banegi.

---

## 9. Measured summary

| Metric | Value |
|---|---|
| CI jobs | 7, all green |
| Job time (sum) | 220s; wall clock kam, chains parallel |
| Bugs found by the first real runs | 4 |
| Naive deploy under load | **15,348 errors** |
| Rolling deploy under load | **0 errors**, 16,883 requests |
| Rolling deploy duration | ~88s for 3 nodes |
| Canary split (weight 9/9/1) | **5.3%** to canary (expected 1/19), 0 errors |
| Blue-green cutover | **1,637ms**, 0 errors, 100% shifted |
| Blue-green rollback | **759ms**, 0 errors |
| Stale-connection 500s | 6 in ~31,000 requests (**0.019%**) |
| Retry recoveries observed | **0 of 46** -- fix is unproven |
| Files in public repo | 171, 1.0 MB, 0 legacy paths |

Sab kuch is machine par aur real GitHub Actions runners par naapa gaya.
Koi projected number nahi.
