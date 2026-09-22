# Phase 12 -- Docker / Containerization

Status: complete. Every number below was measured on this machine, not estimated.
Where something is an assumption or a design choice rather than a measurement, it
says so.

---

## 1. What we built

| Artefact | What it is | Size | Scan |
|---|---|---|---|
| `ledgercore-api:local` | API + worker runtime (same image, different CMD) | 292 MB | 0C 0H 0M 0L fixable, health B (78%) |
| `ledgercore-web:local` | React SPA served by nginx, no Node at runtime | 21.9 MB | 0C 0H 0M 0L fixable, health B (78%) |
| `ledgercore-migrate:local` | `build` stage, used only by `compose run --rm migrate` | 485 MB | not deployed -- runs and exits |

Concretely, this phase added or changed:

- `ledgercore/Dockerfile` -- Prisma artefact pruning moved into the `prod-deps`
  stage; npm/corepack stripped from the runtime stage.
- `ledgercore-web/Dockerfile` -- new. Two stages, nginx runtime, non-root, pinned
  to `nginx:1.31.6-alpine-slim`.
- `ledgercore-web/nginx.conf` -- gzip, security headers, `/healthz`, immutable
  asset caching, `no-store` on `index.html`, SPA fallback.
- `ledgercore-web/docker-entrypoint.sh` -- writes `config.js` at container start.
- `ledgercore-web/.dockerignore`
- `ledgercore/docker-compose.yml` -- new `web` service in the `scale` profile;
  nginx healthcheck fixed; `CORS_ORIGINS` extended.

Hinglish: is phase mein koi nayi business feature nahi bani. Jo cheez bani hai woh
hai **shipping discipline** -- image chhoti, surface kam, aur "container healthy
hai" ka matlab sach mein healthy ho.

---

## 2. Why we built it (the decisions)

### Decision 1: Prisma artefacts prune karo, aur SAHI stage mein karo

**Problem.** `docker history` ne dikhaya ki 373 MB image mein `node_modules`
akela 124 MB tha. Uska aadha Prisma ka woh saamaan tha jo ye container kabhi load
hi nahi karta:

```
3 x 15.4 MB   libquery_engine-linux-musl-openssl-3.0.x.so.node
              prisma/, @prisma/engines/, aur @prisma/client ke generated
              .prisma/client/ -- teen copies. Load sirf AAKHRI hoti hai.
              Baaki do isliye hain kyunki `prisma` CLI @prisma/client ki peer
              dependency hai, to --prod install par bhi aa jaati hai.

1 x 17.9 MB   schema-engine -- sirf `prisma migrate` use karta hai. Migrations
              alag `migrate` image se chalti hain.

~6 MB         query_engine_bg.{mysql,sqlite}.wasm -- app Postgres-only hai.
```

**Options.**

| Option | Result |
|---|---|
| A. `binaryTargets` schema mein pin karo | schema.prisma edit karna is task ke scope se bahar tha |
| B. Runtime stage mein delete karo | Try kiya. **373 MB -> 373 MB. Zero fayda.** |
| C. `prod-deps` stage mein delete karo, COPY se pehle | **373 MB -> 292 MB (-22%)** |

**Chosen: C.**

**Why.** Ye Docker ka sabse zaroori mental model hai: **ek layer sirf ADD kar
sakti hai.** Runtime stage mein `rm` karne se final filesystem se file gayab ho
jaati hai, lekin bytes pichhli `COPY` layer mein baithe rehte hain aur har deploy
par pull hote hain. `rm` sirf ek whiteout entry likhta hai. Isliye delete usi
stage mein hona chahiye jahan bytes **paida** hue -- `COPY --from` se pehle.

Ye maine galat karke seekha: pehla attempt runtime stage mein tha aur size bilkul
nahi hila. Wahi `find` commands `prod-deps` mein daalte hi 81 MB gaye.

**Trade-off.** Prune name se scoped hai, path-glob se nahi, isliye ye us ek engine
ko chhoo hi nahi sakta jo load hota hai. Phir bhi build mein ek guard hai --
agar woh engine kabhi gayab hua to build **FATAL** ke saath fail hoti hai,
runtime par nahi. Ek Prisma major upgrade in filenames ko badal sakta hai; guard
isliye hai ki woh din build break kare, 3 baje raat ko production nahi.

### Decision 2: npm ko runtime image se nikaal do

**Problem.** `docker scout quickview ledgercore-api:local` -> **1 CRITICAL, 19
HIGH fixable.** Health score C (56%).

Har ek finding in packages mein tha: `tar`, `minimatch`, `brace-expansion`,
`cross-spawn`, `ip-address`, `glob`, `sigstore`, `pacote`. `pnpm why` ne inme se
ek bhi app tree mein nahi dhoonda. Ye sab **npm ki apni bundled dependencies**
thin, jo `node:20-alpine` base image ke andar
`/usr/local/lib/node_modules/npm` par padi hain (`tar` 6.2.1, waghairah).

**Options.**

| Option | Trade-off |
|---|---|
| A. Ignore karo -- "hamari dependency nahi hai" | Scan gate CI mein laal rehta; koi na koi use ignore karna seekh jaata |
| B. npm upgrade karo image ke andar | Base image ke saath ladna; har base bump par phir se |
| C. Distroless / `node:20-alpine` ke bajaye scratch+node | Bada kaam, aur shell na hone se debugging mushkil |
| D. npm aur corepack runtime stage se delete kar do | **0C 0H 0M 0L**, score C (56%) -> **B (78%)** |

**Chosen: D.**

**Why.** Runtime `node dist/server.js` chalata hai. Woh kabhi package manager
invoke nahi karta. To npm sirf attack surface hai -- 20 CVE aur ~10 MB, badle
mein kuch nahi. Build stages mein npm abhi bhi hai; sirf runtime mein nahi.

Asli sabak yahan scanner ke baare mein hai: **scanner ka laal hona
"dependencies patch karo" ka matlab nahi hai. Pehle poochho KAUNSI dependency --
jawab aksar "jo tumne kabhi install hi nahi ki aur zaroorat bhi nahi" hota hai.**
Interview mein ye difference bolna aapko usse alag karta hai jo bas `npm audit fix`
chala deta hai.

**Trade-off.** Image ke andar `npm i` ab possible nahi. Ye feature hai, bug nahi --
production container mein package install karna waise bhi galat hai. Debugging ke
liye `build` stage available hai.

### Decision 3: Frontend ke liye ALAG image, Node ke bina

**Problem.** `ledgercore-web` ka koi Dockerfile tha hi nahi. Asli gap.

**Options.**

| Option | Trade-off |
|---|---|
| A. API image se hi static files serve karo | Express ko static serving mein lagaya -- CSS change par poora ledger redeploy |
| B. `vite preview` / `serve` container mein | Vite docs khud kehte hain ye production ke liye nahi; single-threaded Node static files de raha hai -- dono cheezon ka bura pehlu |
| C. nginx, multi-stage build | Runtime mein JavaScript hai hi nahi |

**Chosen: C.**

**Why.** Do artefacts, do lifecycles. Ek CSS change ko ledger image ko rebuild,
re-scan aur redeploy nahi karana chahiye. Aur kyunki runtime mein Node hai hi
nahi, **woh poora npm CVE surface jo API image ko 20 findings de raha tha, yahan
exist hi nahi karta.**

**Trade-off.** Do images maintain karni hain, aur `API_BASE_URL` ka coordination
manually sambhalna padta hai (neeche Decision 5).

### Decision 4: Base image pin karo -- lekin pin ko RENEW karo

**Problem.** Pehla frontend build `nginx:1.27-alpine` par tha.
`docker scout quickview` -> **7 CRITICAL, 32 HIGH fixable**, health C (56%).
Inme se ek bhi finding is image ke kaam se nahi aayi thi. Sab OS packages the ek
aise tag mein jo bas **purana** ho gaya tha.

**Chosen.** `nginx:1.31.6-alpine-slim`.

**Why.**

- **Refresh:** current patch release par rebuild karne se hi 7C 32H -> 0C 0H.
- **`-slim`:** static server kabhi njs, geoip, perl, image-filter/xslt modules
  load nahi karta. 57 packages kam, ~14 MB kam -- aur har hataaya hua package woh
  cheez hai jisme kal CVE aa sakta tha. Image **74.8 MB -> 21.9 MB (-71%)**.
- **Exact patch pin (`1.31.6`, na ki `1.31` ya `1`):** builds reproducible rehti
  hain, aur renewal ek explicit, reviewable commit banta hai -- chupchaap drift
  nahi.

Sabak, seedha: **ek pinned tag safe nahi rehta; woh bas *same* rehta hai jabki
duniya usme bugs dhoondhti rehti hai.** Isliye base bump ek routine, scheduled
kaam hona chahiye, na ki tab jab koi audit aaye.

### Decision 5: Runtime config injection -- ek image, kai environments

**Problem.** Vite build time par `import.meta.env` ko literal bana ke bake kar
deta hai. Matlab dev/staging/prod ke liye **teen alag images**. Phir "jo image
staging mein test hui thi wahi prod gayi" -- ye guarantee khatam.

**Chosen.** `docker-entrypoint.d/40-runtime-config.sh` container **start** par
`/usr/share/nginx/html/config.js` likhta hai:

```js
window.__LEDGERCORE_CONFIG__ = {
  apiBaseUrl: "http://localhost:8080/api/v1",
  environment: "local"
};
```

**Why.** Ek hi image digest dev -> staging -> prod jaata hai. Environment env vars
se aata hai, image se nahi. Ye exactly wahi pattern hai jo legacy app
`Frontend/public/config.js` se kar raha tha -- purane codebase ka ek achha idea,
jo yahan reuse hua.

**Trade-off.** `config.js` ko `no-store` hona chahiye warna browser purana API URL
cache kar lega -- `nginx.conf` mein handled hai. Aur ye config **public** hai:
browser use padh sakta hai, to isme secret kabhi nahi jayega.

---

## 3. How it works

### API image -- 4 stages

```
deps       node:20-alpine + openssl + pnpm
           pnpm install --frozen-lockfile        (full tree, dev included)
              |
build      COPY --from=deps node_modules
           prisma generate && tsc -p tsconfig.build.json
           ^ ye stage `migrate` service bhi banti hai -- sirf yahi stage hai
             jisme Prisma CLI aur prisma/migrations/ dono saath hain
              |
prod-deps  node:20-alpine + openssl + pnpm
           pnpm install --prod && prisma generate (RUNTIME ke SAME base par)
           prune: schema-engine, duplicate query engines, mysql/sqlite wasm
           guard: agar loaded engine gayab -> build FATAL
              |
runtime    node:20-alpine + tini + openssl
           npm/corepack removed
           COPY --from=prod-deps node_modules   <- already pruned
           COPY --from=build     dist
           USER node (uid 1000)
           HEALTHCHECK -> /readiness
           ENTRYPOINT tini -- ; CMD node dist/server.js
```

`prod-deps` runtime ke **same Alpine base** par `prisma generate` chalata hai.
Ye Alpine/OpenSSL trap ka fix hai (neeche section 4).

Worker isi image se chalta hai, sirf `command: ["node", "dist/worker.js"]`. Do
images ka drift karna hi possible nahi.

### Frontend image -- 2 stages

```
build      node:20-alpine + pnpm
           pnpm exec vite build        <- `pnpm build` NAHI (woh tsc -b bhi chalata)
              |
runtime    nginx:1.31.6-alpine-slim
           COPY --from=build /app/dist -> /usr/share/nginx/html
           nginx.conf + 40-runtime-config.sh
           USER nginx, EXPOSE 8080
           HEALTHCHECK -> /healthz
```

`pnpm exec vite build` deliberate hai: typechecking CI ka kaam hai (Phase 13),
jahan failure fast aur readable hoti hai. Iska seedha natija ye hai ki **ye image
aise code se ban sakti hai jo typecheck nahi hota** -- CI hi woh cheez hai jo use
registry tak pahunchne se rokegi.

### nginx.conf -- caching ka asli hissa

```
/assets/*      Cache-Control: public, max-age=31536000, immutable
index.html     Cache-Control: no-store, must-revalidate
config.js      Cache-Control: no-store
```

Ye Vite ke content-hashed filenames (`index-DROv45W7.js`) par tika hai. Content
badla -> filename badla -> naya URL. Isliye assets ko ek saal cache karna safe
hai. `index.html` woh ek file hai jise **kabhi** cache nahi karna, kyunki wahi in
hashed filenames ko point karti hai -- use cache kar diya to browser naye deploy
ko dekhega hi nahi.

Measured:

```
/assets/index-DROv45W7.js -> Cache-Control: max-age=31536000
                             Cache-Control: public, immutable
                             Content-Encoding: gzip
/index.html               -> Cache-Control: no-store, must-revalidate
```

SPA fallback `try_files $uri $uri/ /index.html` hai, lekin **`/assets/` ke liye
nahi**. Measured:

```
/                 -> 200
/branches/abc     -> 200   (router client-side resolve karega)
/assets/nope.js   -> 404   (index.html NAHI -- warna missing bundle par browser
                            ko HTML milta aur error "Unexpected token '<'" hoti)
```

### End-to-end, jaisa browser karta hai

```
docker compose --profile scale up -d
```

Measured, `Origin: http://localhost:3002` ke saath:

```
1. frontend            localhost:3002 -> <title>LedgerCore</title>
                       /config.js     -> apiBaseUrl http://localhost:8080/api/v1

2. CORS preflight      OPTIONS /api/v1/auth/login -> 204
                       Access-Control-Allow-Origin: http://localhost:3002
                       Access-Control-Allow-Credentials: true
                       Access-Control-Allow-Headers: Content-Type,Authorization,
                                                     X-Request-Id,Idempotency-Key

3. login via LB        POST /api/v1/auth/login -> 200, accessToken 384 chars

4. authenticated read  GET /api/v1/auth/me
                       call 1 -> 200  upstream=172.20.0.10:4000
                       call 2 -> 200  upstream=172.20.0.9:4000
                       call 3 -> 200  upstream=172.20.0.8:4000
```

Aur pruned image graceful shutdown abhi bhi karti hai (`docker compose stop api-1`,
rebuild ki hui `:local` par measure kiya) -- **EXIT CODE 0**, 137 nahi:

```
06:03:19.063  shutdown initiated              signal=SIGTERM drainDelayMs=10000
06:03:19.064  readiness now reporting not-ready (draining)
06:03:22.939  GET /readiness -> 503           <- HEALTHCHECK ne drain dekha
06:03:29.064  http server closed, no in-flight requests remain
06:03:29.076  cache disconnected
06:03:29.097  database disconnected
06:03:29.097  shutdown complete
```

Yaani prune ne na engine loading todi, na signal handling, na drain sequence.

Poora stack healthy:

```
ledgercore-api-1       Up (healthy)
ledgercore-api-2       Up (healthy)
ledgercore-api-3       Up (healthy)
ledgercore-nginx       Up (healthy)
ledgercore-pgbouncer   Up (healthy)
ledgercore-postgres    Up (healthy)
ledgercore-redis       Up (healthy)
ledgercore-redis-queue Up (healthy)
ledgercore-web         Up (healthy)
ledgercore-worker-1    Up
```

---

## 4. What can fail

Ye section un cheezon ka hai jo is phase mein **sach mein** fail huin.

### 4.1 Layer semantics -- delete se image chhoti nahi hoti

Runtime stage mein 50+ MB delete kiya. **373 MB -> 373 MB.**

Layer sirf add karti hai. `rm` whiteout likhta hai; bytes pichhli layer mein
rehte hain aur pull hote hain. Fix: delete wahan jahan bytes bane.

**Detect kaise karein:** `docker history <image>` -- agar ek layer bari hai aur
baad wali "delete" layer ~0 B hai, to aapne kuch nahi bachaya.

### 4.2 Alpine/OpenSSL Prisma trap -- build green, container first query par dead

`prisma/schema.prisma` mein `binaryTargets` declare nahi hai, to Prisma engine
machine sniff karke chunta hai -- aur woh **do baar** sniff karta hai: ek baar
generate par, ek baar client startup par.

`node:20-alpine` libraries (`/usr/lib/libssl.so.3`) deta hai par **openssl CLI
nahi**. Prisma 5.22 `openssl version` poochhta hai, fail hota hai, aur print
karta hai "Prisma failed to detect the libssl/openssl version ... Defaulting to
openssl-1.1.x" -- **warning, error nahi, to build green ho jaati hai** -- aur
`libquery_engine-linux-musl.so.node` likh deta hai, jo `libssl.so.1.1` maangta
hai. Alpine 3.23 mein woh hai hi nahi.

Measured, fix se pehle, isi image par:

```
Error loading shared library libssl.so.1.1: No such file or directory
```

Aur sirf build stage fix karne par doosri taraf se toot-ta hai:

```
Prisma Client could not locate the Query Engine for runtime "linux-musl".
This happened because Prisma Client was generated for
"linux-musl-openssl-3.0.x", but the actual deployment required "linux-musl".
```

Fix: `apk add openssl` **dono** jagah -- `prod-deps` (generate) aur `runtime`
(load). Aur production dependencies runtime ke same base par install karo, taaki
kuch bhi libc boundary cross na kare.

### 4.3 Healthcheck jhooth bolta hai -- ab DO baar

**Pehla (Phase 11):** pgBouncer ka `nc -z localhost 6432`. busybox `nc` mein
`-z` flag hai hi nahi. pgBouncer 143 queries/s serve kar raha tha aur
"unhealthy" mark tha; har api node `condition: service_healthy` par ruk gaya.

**Doosra (is phase mein):** nginx LB "unhealthy" dikh raha tha, jabki uske apne
access log mein teeno nodes ko `status=200` ja raha tha.

```
healthcheck log : wget: can't connect to remote host: Connection refused
nginx access log: GET /api/v1/auth/me status=200 upstream=172.20.0.12:4000
```

Container ke andar reproduce:

```
wget localhost   -> Connection refused
wget 127.0.0.1   -> "nginx ok"
wget [::1]        -> Connection refused
nginx.conf       -> listen 80;        (sirf IPv4)
```

busybox `localhost` ko pehle `::1` resolve karta hai; nginx sirf IPv4 par bind
hai. Fix: healthcheck ko explicit `127.0.0.1` par pin karo.

Ye harmless sirf isliye raha kyunki `web` aur api nodes nginx par plain
`depends_on` rakhte hain. Kahin bhi `condition: service_healthy` add karo aur ye
poore stack ka deadlock ban jaata hai -- bilkul wahi jo pgBouncer wale ne kiya
tha.

**General rule:** healthcheck kabhi aise binary, flag ya naam par mat rakho jo
aapne verify nahi kiya. Ek jhoota healthcheck **healthcheck na hone se bura hai**,
kyunki woh healthy service ko down declare karke sab downstream le doobta hai.

### 4.4 Dual-stack `localhost` -- port bind ho gaya, phir bhi galat app serve hui

Frontend `3001` par map kiya. Bind success. `curl http://localhost:3001` ne
**legacy Piping Mart admin dashboard** return kiya, jisme `/@vite/client` bhi tha
-- aisi cheez jo `vite build` ke output mein aa hi nahi sakti.

Container bilkul theek tha. Host port shadowed tha:

```
docker (PID 20220) : 0.0.0.0:3001  aur  [::]:3001     <- wildcard
stray node (27244) : [::1]:3001                        <- specific

curl 127.0.0.1:3001 -> <title>LedgerCore</title>
curl [::1]:3001     -> <title>The Piping Mart - Admin Dashboard</title>
curl localhost:3001 -> <title>The Piping Mart - Admin Dashboard</title>
```

Ek specific bind wildcard ko haraata hai, aur `localhost` pehle `::1` resolve
hota hai. Isse bhi bura: maine port free hai ya nahi ye `/dev/tcp/127.0.0.1/3001`
se check kiya tha -- jo **sirf IPv4 dekhta hai** -- isliye usne "free" bola.

Ye 4.3 ka ulta hai, root cause wahi: **dual-stack host par `localhost` do address
hain.** Fix: `3002` (dono stacks par free), aur `CORS_ORIGINS` update.

### 4.5 Stale tag -- sudhaar Dockerfile mein tha, image mein nahi

Prune aur npm-strip verify karte waqt maine scratch tags use kiye
(`ledgercore-api:slim`, `:scanned`). Compose `image: ledgercore-api:local`
reference karta hai -- aur `:local` **42 minute purani, 372 MB, npm-wali** image
thi. Yaani stack abhi bhi pehle wali image chala raha tha.

```
ledgercore-api:slim     292MB   7 minutes ago
ledgercore-api:scanned  373MB   11 minutes ago
ledgercore-api:local    372MB   42 minutes ago   <- compose isi ko uthata hai
```

Rebuild ke baad verify:

```
ledgercore-api:local  292MB
  engines: .prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node  (sirf ek)
  npm present? NO -- stripped
  node_modules: 66.0M
  runs as: node
```

**Sabak:** "Dockerfile fix ho gaya" != "deploy hone wali image fix ho gayi".
Ye woh gap hai jise Phase 13 (CI/CD) structurally band karta hai -- image build
aur tag pipeline banati hai, haath se nahi.

### 4.6 Baaki failure modes (ye is baar nahi hue, par honge)

- **`container_name` scaling rok deta hai.** Phase 8 mein `--scale worker=3` ne
  chupchaap ek worker chalaya. Isliye `worker` par ab koi `container_name` nahi.
- **Base image drift.** Aaj `nginx:1.31.6-alpine-slim` 0C 0H hai. 6 mahine baad
  nahi hoga. Ye ek scheduled kaam hai.
- **`config.js` cache ho gaya** -> browser purane API URL par chipak jayega.
  `no-store` isi liye hai.
- **`API_BASE_URL` internal hostname par set kar diya** (`http://nginx/api/v1`)
  -> page ki har request fail, kyunki wo URL browser padhta hai, container nahi.
- **CORS origin mismatch** -> API 200 deta hai aur browser phir bhi block karta
  hai. Port change karo to `CORS_ORIGINS` bhi badlo.

---

## 5. How to debug it

```bash
# Image mein size kahan hai
docker history ledgercore-api:local
docker run --rm --entrypoint sh ledgercore-api:local -c 'du -sh node_modules dist'

# Vulnerabilities -- aur kiski
docker scout quickview ledgercore-api:local
docker scout cves ledgercore-api:local
pnpm why <package>          # jawab aksar: "ye hamare tree mein hai hi nahi"

# Prisma engine sahi hai ya nahi
docker run --rm --entrypoint sh ledgercore-api:local -c \
  "find node_modules -name 'libquery_engine*'"
# exactly ek hona chahiye: .prisma/client/libquery_engine-linux-musl-openssl-3.0.x

# Healthcheck kyun fail ho raha
docker inspect -f '{{range .State.Health.Log}}{{.ExitCode}} {{.Output}}{{end}}' <c>
docker exec <c> sh -c 'wget -qO- http://127.0.0.1:<port>/<path>'
# localhost vs 127.0.0.1 vs [::1] -- teeno alag alag try karo

# Port par kaun baitha hai (dual-stack!)
docker port <container>
netstat -ano | grep ':<port> '
curl http://127.0.0.1:<port>/ ; curl "http://[::1]:<port>/"

# Compose jo image utha raha hai wahi latest hai?
docker images | grep ledgercore
docker compose --profile scale up -d --build

# Frontend
curl -s localhost:3002/config.js                         # runtime config
curl -D- -o /dev/null localhost:3002/assets/<hashed>.js  # cache headers
curl -o /dev/null -w '%{http_code}' localhost:3002/assets/nope.js   # 404 hona chahiye
```

---

## 6. Interview questions

**Q1. Aapne multi-stage build use kiya -- fayda kya, sirf size?**
Size sabse chhota fayda hai. Asli fayda ye hai ki **build-time capabilities
runtime image mein nahi jaatin.** Is image ke runtime mein compiler nahi,
package manager nahi, aur Prisma ka schema-engine bhi nahi -- woh migrate karne
ka tool hai, aur production serving container mein migration tool rakhna dead
weight ke saath unnecessary capability bhi hai.

**Q2. Aapne image se 50 MB delete kiya par size same raha. Kyun?**
Kyunki ek layer sirf ADD kar sakti hai. Baad ki layer mein `rm` ek whiteout entry
likhta hai; bytes pichhli layer mein rehte hain aur har pull par aate hain.
Delete usi stage mein karna padta hai jahan file **bani** -- `COPY --from` se
pehle. Maine ye measure karke dekha: runtime stage mein delete = 373 -> 373 MB,
`prod-deps` mein wahi delete = 373 -> 292 MB.

**Q3. Scanner ne 1 critical aur 19 high dikhaye. Aapne kya kiya?**
Pehle poochha **kaunse packages**. Saare `tar`, `minimatch`, `glob`, `pacote`
jaise the -- `pnpm why` ne ek bhi app tree mein nahi dhoonda. Woh npm ki apni
bundled dependencies thin, base image ke andar. Runtime `node dist/server.js`
chalata hai aur kabhi package manager invoke nahi karta, to npm aur corepack
hata diye: 0C 0H 0M 0L. Sabak -- scanner ka laal hona hamesha "dependency patch
karo" nahi hota; pehle ye poochho ki woh dependency aapke process ke liye
**reachable** bhi hai ya nahi.

**Q4. Base image pin karna best practice hai. To 7 critical kahan se aaye?**
Pin karne se image safe nahi hoti, bas **same** rehti hai. `nginx:1.27-alpine`
mahino purana tha; us beech uske OS packages mein CVE mile. Current patch release
par rebuild karne se 7C 32H -> 0C 0H. Isliye pin exact patch par hona chahiye
(reproducibility ke liye) **aur** uska renewal ek routine scheduled kaam hona
chahiye. Pin + never-renew sabse kharab combination hai.

**Q5. Frontend ke liye alag image kyun, API se hi serve kyun nahi?**
Alag lifecycle. Ek CSS change ko ledger image rebuild, re-scan aur redeploy nahi
karani chahiye. Aur ek concrete security fayda -- frontend runtime mein Node hai
hi nahi, to woh poora npm CVE surface jo API image ko 20 findings de raha tha,
wahan exist nahi karta. Image 21.9 MB hai, API 292 MB.

**Q6. Ek hi image staging aur prod dono mein kaise jaati hai jab API URL alag hai?**
Vite build time par env vars bake kar deta hai, to naive tareeke se aapko teen
images chahiye -- aur "jo test hui wahi deploy hui" guarantee khatam. Iske bajaye
entrypoint container **start** par `config.js` likhta hai aur app
`window.__LEDGERCORE_CONFIG__` padhta hai. Ek digest sab environments mein.
`config.js` `no-store` hona zaroori hai, warna browser purana API URL cache kar
lega. Aur usme secret kabhi nahi -- woh file public hai.

**Q7. Assets ko ek saal cache karna safe kaise hai?**
Kyunki Vite filenames content-hash karta hai (`index-DROv45W7.js`). Content badla
to filename badla to URL naya -- stale asset serve ho hi nahi sakta. Isliye
`public, max-age=31536000, immutable`. Lekin `index.html` par `no-store` hona
chahiye, kyunki wahi un hashed names ko point karti hai; use cache kar diya to
browser naya deploy dekhega hi nahi.

**Q8. SPA fallback `try_files ... /index.html` -- iska khatra kya hai?**
Agar aap `/assets/` ko bhi fallback kar dein, to missing bundle par browser ko
200 ke saath HTML milta hai aur error aati hai `Unexpected token '<'` -- jo asli
wajah (file hai hi nahi) chhupa deti hai. Isliye app routes fallback karte hain,
assets nahi: `/branches/abc` -> 200, `/assets/nope.js` -> 404.

**Q9. Container "unhealthy" dikh raha hai par service kaam kar rahi hai. Kaise
debug karenge?**
Mere saath ye do baar hua, dono baar healthcheck galat tha, service nahi.
pgBouncer: `nc -z` -- busybox `nc` mein `-z` hai hi nahi. nginx: `wget localhost`
-- busybox pehle `::1` resolve karta hai aur nginx sirf `listen 80` (IPv4) par
tha. Pehla step hamesha `docker inspect` se health log padhna aur wahi command
`docker exec` se haath se chalana hai. Aur jhoota healthcheck healthcheck na hone
se **bura** hai, kyunki `condition: service_healthy` par sab downstream ruk jaata
hai.

**Q10. Worker aur API ek hi image se kyun? Alag kyun nahi?**
Worker wahi domain modules import karta hai jo API karta hai -- alag image ka
matlab wahi bytes, alag entrypoint, aur ek aur cheez sync mein rakhne ke liye.
Ek image, `command` alag. Lekin compose mein woh **alag service** hai, API ka
replica nahi: worker queue depth par scale karta hai aur API RPS/latency par, aur
ek ka deploy doosre ko force nahi karta. Worker par `container_name` bhi nahi,
kyunki fixed naam `--scale` ko todta hai.

**Q11. tini kyun? `node` seedha PID 1 kyun nahi?**
Do wajah. Ek, PID 1 ke liye kernel default signal disposition nahi deta -- bina
registered handler ke signal **discard** ho jaata hai. `server.ts` SIGTERM handler
`await connectDatabase()` ke baad register karta hai, to us window mein
`docker stop` chupchaap ignore hota aur container sirf SIGKILL se marta. Do, PID 1
orphan reaper bhi hota hai aur Node reap nahi karta -- Prisma query engine child
process hai, respawn hua to zombie permanent. `docker run --init` yahi binary
inject karta hai; bake karne se guarantee kisi ke flag yaad rakhne par nirbhar
nahi rehti.

**Q12. Aapke container `USER node` / `USER nginx` par chalte hain. Iska asli fayda?**
Ye container escape ko rokta nahi -- uska **blast radius** chhota karta hai.
Non-root process `/usr` mein likh nahi sakta, `apk add` nahi kar sakta, aur
privileged port bind nahi kar sakta. Isi wajah se frontend 80 ke bajaye 8080 par
listen karta hai aur mapping ALB/Service karta hai -- static files public internet
par serve karne wale container ke liye ye extra port mapping worth hai.

---

## 7. Honest gaps

- **Supply chain attestations missing** -- dono images par scout ki ye policy
  abhi fail hai (2 deviations each). SBOM + provenance attestation Phase 13 ka
  kaam hai, kyunki woh build pipeline se generate hoti hai.
- **Copyleft packages** -- scout 17 (web) aur kuch (api) report karta hai. Ek
  internal banking system ke liye distribution nahi ho rahi, isliye practically
  issue nahi; lekin ye claim legal review ka hai, mera nahi.
- **`ledgercore-migrate:local` 485 MB hai** aur prune nahi hui. Jaan-bujh kar --
  woh deploy hoti hi nahi, `run --rm` se chalti hai aur exit ho jaati hai, aur
  usme schema-engine chahiye hi chahiye.
- **Images kahin push nahi hui.** Sab kuch local tags hai. Registry, tagging
  strategy aur immutable digest deploys Phase 13 mein.
- **Health score B (78%), A nahi** -- bacha hua gap upar wale do policies hain,
  vulnerabilities nahi.

---

## 8. Measured summary

| Metric | Before | After |
|---|---|---|
| API image size | 373 MB | **292 MB** (-22%) |
| API fixable CVEs | 1C 19H | **0C 0H 0M 0L** |
| API health score | C (56%) | **B (78%)** |
| API `node_modules` | 118.6 MB | **66.0 MB** |
| API Prisma engines in image | 3 + schema-engine | **1** |
| Frontend image | none (gap) | **21.9 MB** |
| Frontend after base bump | 74.8 MB, 7C 32H, C (56%) | **21.9 MB, 0C 0H, B (78%)** |

Sab kuch is machine par measure kiya gaya. Koi projected number nahi.
