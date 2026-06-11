# Migración mkpdfs-backend: Serverless Framework → AWS CDK

> Inventario verificado contra código + AWS vivo (cuenta 197837191835, profile `rocketeast`) el 2026-06-10.
> Convenciones base: `~/.claude/commands/setup-aws-backend.md` + skill `aws-cdk-development`.

---

# INVENTARIO

**Stacks CFN físicos**: `mkpdfs-api-dev` (UPDATE_COMPLETE) y `mkpdfs-api-prod` (UPDATE_COMPLETE, ~243 recursos). Servicio Serverless v3 `mkpdfs-api`, runtime nodejs20.x, us-east-1. NO existe stack `stage` (solo está en config). Repo: `/Users/sim4r4/sim4r4/repos/mkpdfs/mkpdfs-backend`.

## (a) Lambdas — 32 en repo, **31 en prod** (`updateTemplate` está en repo pero NO deployada a prod: prod va atrás del repo)

Nombre físico = `mkpdfs-api-{stage}-{nombre}`. Defaults Serverless: timeout 6s / mem 1024MB (verificado en vivo). Authorizer "Cognito" = `ApiGatewayAuthorizer` (COGNITO_USER_POOLS contra el pool activo). Todas las HTTP llevan `cors: true` (genera OPTIONS MOCK por ruta).

| Función | Ruta + método | Auth | Timeout/Mem | Layer chromium | Evento no-HTTP |
|---|---|---|---|---|---|
| getUserProfile | GET /user/profile | Cognito | 6/1024 | — | — |
| updateUserProfile | PUT /user/profile | Cognito | 6/1024 | — | — |
| listUserTokens | GET /user/tokens | Cognito | 6/1024 | — | — |
| createUserToken | POST /user/tokens | Cognito | 6/1024 | — | — |
| deleteUserToken | DELETE /user/tokens/{tokenId} | Cognito | 6/1024 | — | — |
| getUserUsage | GET /user/usage | Cognito | 6/1024 | — | — |
| listUserTemplates | GET /templates | Cognito | 6/1024 | — | — |
| getUserTemplate | GET /templates/{templateId} | Cognito | 6/1024 | — | — |
| uploadTemplate | POST /templates/upload | Cognito | 6/1024 | — | — |
| updateTemplate | PUT /templates/{templateId} | Cognito | 6/1024 | — | — (NO está en prod) |
| deleteTemplate | DELETE /templates/{templateId} | Cognito | 6/1024 | — | — |
| generatePdf | POST /pdf/generate | Cognito | 30/2048 | SI | — |
| generatePdfAsync | POST /pdf/generate-async | Cognito | 60/2048 | SI | — (deprecated según CLAUDE.md) |
| generatePdfApiKey | POST /v1/pdf/generate | **NINGUNO** (auth in-lambda `x-api-key: tlfy_*`) | 30/2048 | SI | — |
| submitJob | POST /jobs/submit | Cognito | 30/256 | — | — |
| getJobStatus | GET /jobs/{jobId} | Cognito | 10/256 | — | — |
| processJob | — | — | 300/2048, **reservedConcurrency 10** | SI | SQS PdfGenerationQueue (batch 1, window 0) |
| preSignUp | — | — | 6/1024 | — | Cognito trigger PreSignUp (`existing:false` ⚠️) |
| postConfirmation | — | — | 6/1024 | — | Cognito trigger PostConfirmation (`existing:false` ⚠️); env override USERS_TABLE |
| stripeCreateCheckoutSession | POST /stripe/create-checkout-session | Cognito | 6/1024 | — | — |
| stripeCreatePortalSession | POST /stripe/create-portal-session | Cognito | 6/1024 | — | — |
| stripeWebhook | POST /stripe/webhook | **NINGUNO** (firma Stripe) | 6/1024 | — | — |
| marketplaceListTemplates | GET /marketplace/templates | **público** | 6/1024 | — | — |
| marketplaceGetTemplate | GET /marketplace/templates/{templateId} | **público** | 6/1024 | — | — |
| marketplaceGetTemplatePreview | GET /marketplace/templates/{templateId}/preview | **público** | 6/1024 | — | — |
| marketplaceUseTemplate | POST /marketplace/templates/{templateId}/use | Cognito | 6/1024 | — | — |
| generateAITemplate | POST /ai/generate-template | Cognito | 60/1024 | — | — |
| submitAIGeneration | POST /ai/generate-template-async | Cognito | 30/256 | — | — |
| processAIGeneration | — | — | 300/2048, **reservedConcurrency 5** | SI | SQS AIGenerationQueue (batch 1, window 0) |
| getAIJobStatus | GET /ai/jobs/{jobId} | Cognito | 10/256 | — | — |
| getAIImageUploadUrl | POST /ai/image-upload-url | Cognito | 10/256 | — | — |
| contactEnterprise | POST /contact/enterprise | **público** (rate-limit por IP en DDB) | 6/1024 | — | — |

No hay schedules, streams consumers, EventBridge ni Step Functions. Bundling: serverless-esbuild (bundle, no minify, sourcemap, target node20, exclude `@sparticuz/chromium*`; puppeteer-core bundleado).

## (b) DynamoDB — 9 tablas, `mkpdfs-{stage}-*`, todas PAY_PER_REQUEST (STATEFUL, datos reales en prod)

| Tabla física | Keys | GSIs | Stream / TTL / PITR |
|---|---|---|---|
| mkpdfs-{stage}-users | PK userId | email-index (HASH email, ALL) | Stream NEW_AND_OLD_IMAGES (sin consumer); PITR ON |
| mkpdfs-{stage}-tokens | PK token | userId-index (HASH userId, ALL) | TTL `expiresAt` |
| mkpdfs-{stage}-usage | PK userId, SK yearMonth | — | — |
| mkpdfs-{stage}-subscriptions | PK userId | — | Stream NEW_AND_OLD_IMAGES (sin consumer) |
| mkpdfs-{stage}-templates | PK userId, SK templateId | — | — |
| mkpdfs-{stage}-marketplace | PK templateId | category-index (HASH category, ALL) | — |
| mkpdfs-{stage}-jobs | PK jobId | userId-createdAt-index (HASH userId, RANGE createdAt, ALL) | TTL `ttl` |
| mkpdfs-{stage}-rate-limits | PK pk, SK sk | — | TTL `ttl` |
| mkpdfs-{stage}-ai-jobs | PK jobId | userId-createdAt-index (ALL) | TTL `ttl` |

## (c) Cognito — ⚠️ HALLAZGO CRÍTICO: hay DOS pools por stage (bug vivo)

| Recurso | prod | dev | Nota |
|---|---|---|---|
| UserPool ACTIVO (logical `CognitoUserPool`, de resources/cognito.ts) | **us-east-1_TvN4BAI17** (4 usuarios) | **us-east-1_W7zAXUV7k** | `LambdaConfig: {}` — **SIN triggers** |
| UserPool DUPLICADO (logical `CognitoUserPoolMkpdfsproduserpool`, auto-creado por el evento `cognitoUserPool existing:false` de Serverless) | us-east-1_hsVNQxLrh (0 usuarios) | us-east-1_y3O32FfRc | Tiene los triggers preSignUp/postConfirmation — **los triggers NUNCA disparan para usuarios reales** |
| UserPoolClient | hib8dmpit5e2sb63ojqhf7rn8 | 7hpknj4jc5atcc4phuao5sr3j9 | sin secret, SRP+password+refresh, OAuth code; callbacks `localhost:3000` + `mkpdfs.com/callback` (⚠️ falta dev.mkpdfs.com) |
| Hosted UI Domain | auth-mkpdfs-prod | auth-mkpdfs-dev | prefijo Cognito (no custom) |
| Google IdP | SI — secrets en SecretsManager `mkpdfs/google-oauth/{stage}` (client_id/client_secret via dynamic ref) | idem | scopes openid email profile |
| IdentityPool | us-east-1:6679055d-e6a8-45cc-8e61-a183402bc75d | us-east-1:d9a3a66d-1ae3-4600-87e0-e9b583a9cfac | + IdentityPoolRoleAttachment + CognitoAuthRole (execute-api:Invoke `*`) |
| Pool config | MFA OPTIONAL (TOTP), AdvancedSecurity ENFORCED, email username, password 8+todos | | |

## (d) S3

| Bucket físico | Notas |
|---|---|
| mkpdfs-prod-bucket / mkpdfs-dev-bucket | **STATEFUL** (templates de usuarios, PDFs, thumbnails marketplace, lambda-layers/). Ya tiene `DeletionPolicy: Retain`. Versioning ON, AES256, lifecycle `pdfs/` 30d, CORS *, BucketPolicy lectura pública `marketplace/thumbnails*` |
| mkpdfs-api-{stage}-serverlessdeploymentbucket-* | artefactos Serverless — muere con el stack viejo |

## (e) SQS

| Cola física | Config |
|---|---|
| mkpdfs-{stage}-pdf-generation | VisTimeout 360s, retención 4d, long-poll 20s, redrive→DLQ maxReceive 3 |
| mkpdfs-{stage}-pdf-generation-dlq | retención 14d |
| mkpdfs-{stage}-ai-generation | VisTimeout 600s, retención 4d, redrive maxReceive 2 |
| mkpdfs-{stage}-ai-generation-dlq | retención 14d |

## (f) Layer chromium

`arn:aws:lambda:us-east-1:197837191835:layer:mkpdfs-chromium:1` — **misma cuenta** (no externa), publicada una sola vez desde `s3://mkpdfs-prod-bucket/lambda-layers/` (Sparticuz v143 x64). Compartida dev+prod por las 5 lambdas de PDF/AI-thumbnail. NO la gestiona el stack — en CDK basta `LayerVersion.fromLayerVersionArn`. El dir `layers/puppeteer/` que referencia deploy.yml **YA NO EXISTE en el repo** (workflow stale).

## (g) Custom domains (serverless-domain-manager, endpointType **edge**, TLS 1.2)

| Dominio | Cert ACM | Mapeo actual (verificado) |
|---|---|---|
| apis.mkpdfs.com | cbc979b6-0d23-4997-bb6e-0ee72ac3557a | basePath `''` → RestApi **a6njd1d2rh** stage `prod` (CF d1nqji12rleab.cloudfront.net) |
| dev.apis.mkpdfs.com | 1a16de41-d72e-4c71-8cff-f678dc9ea6b3 | basePath `''` → RestApi **9t7amf2ofc** stage `dev` (CF dwzeqtn5numym.cloudfront.net) |

Hosted zone `Z0217803KO361QOLBIHN`, records A+AAAA creados por el plugin. El dominio/Route53 los crea el plugin por API (fuera de CFN) — sobreviven al borrar el stack (verificar mapping en stack antes del delete). Gateway Responses CORS en 4XX/5XX/ACCESS_DENIED/UNAUTHORIZED/EXPIRED_TOKEN.

## (h) SSM / Secrets

Los `${ssm:}` se resuelven EN DEPLOY-TIME a env vars de Lambda — los secrets de Stripe viven en plaintext en la config de Lambda hoy.

| Param | dev | prod |
|---|---|---|
| /mkpdfs/{stage}/stripe-secret-key, stripe-webhook-secret (SecureString); stripe-price-basic, stripe-price-professional (String) | SI | SI |
| /mkpdfs/dev/twilio-* (account-sid, api-key-sid/secret, from-number), enterprise-contact-phone | SI | **NO — faltan en prod** (contactEnterprise los lee runtime) |
| SecretsManager mkpdfs/google-oauth/{stage} | SI | SI |

## (i) IAM

UN solo rol compartido para las 32 lambdas (rol default Serverless), statements: DDB CRUD sobre `mkpdfs-{stage}-*` + índices; S3 RW bucket; `ses:Send*` sobre `*`; lambda:InvokeFunction self-service; ssm:GetParameter(s) `/mkpdfs/{stage}/*`; bedrock:InvokeModel `anthropic.claude-*` + inference-profiles `us.anthropic.claude-*`; SQS send/receive/delete sobre las 4 colas. FROM_EMAIL noreply@mkpdfs.com (SES).

## (j) CI/CD

- `ci.yml`: PR → typecheck (no hay tests ni linter reales).
- `deploy.yml`: push dev/stage/main → `serverless deploy` con OIDC (`secrets.AWS_ROLE_ARN_DEV/STAGE/PROD` — ya hay roles OIDC en la cuenta). ⚠️ **Workflow ROTO/stale**: paso `cd layers/puppeteer && npm install` contra un dir que ya no existe → los deploys actuales son locales (`AWS_PROFILE=rocketeast`, user IAM `rocket`, no SSO).

## STATEFUL que NO PUEDE recrearse

- 9 tablas DDB prod (datos reales)
- Pool us-east-1_TvN4BAI17 (4 usuarios; passwords NO exportables)
- Client ID + IdentityPool ID (horneados en el frontend)
- Bucket mkpdfs-prod-bucket
- Hosted UI domain `auth-mkpdfs-prod`
- Los 2 custom domains
- SQS = semi-stateful (jobs in-flight)

---

# BORRADOR DE PLAN — Migración a CDK (patrón setup-aws-backend)

## Estructura CDK propuesta

`mkpdfs-backend` mismo repo, TypeScript, NodejsFunction/esbuild local, `-c environment={dev|prod}`:

```
bin/mkpdfs.ts                     → Mkpdfs-{Stack}-{env}
lib/stacks/database-stack.ts      → 9 tablas (fase 1: ITable refs; fase 2: importadas)
lib/stacks/auth-stack.ts          → pool/client/identity-pool (refs), CognitoAuthRole+attachment, triggers
lib/stacks/storage-stack.ts       → bucket (ref) + policy
lib/stacks/jobs-stack.ts          → 4 colas SQS + processJob/processAIGeneration + layer ref
lib/stacks/api-stack.ts           → RestApi + 27 lambdas HTTP + authorizer + GatewayResponses + BasePathMapping
lib/stacks/github-oidc-stack.ts   → rol deploy (o reusar AWS_ROLE_ARN_* existentes)
src/functions/** y src/libs/**    → SIN CAMBIOS (los handlers no se tocan)
```

Convenciones del skill aplicadas: sin `defaultCorsPreflightOptions` (Middy httpCors + GatewayResponses — ojo, hoy las lambdas dependen de los OPTIONS MOCK del plugin; añadir httpCors al middyfy), **sin `functionName` explícito** (evita colisión con `mkpdfs-api-{stage}-*` viejas y permite coexistencia), grants por-función en vez del mega-rol, SSM en runtime (saca el secret de Stripe del env plaintext — mejora, validar con el dueño), Powertools logger.

## Estrategia stateful — evaluación

| Opción | Pros | Contras |
|---|---|---|
| (1) Retain → remover del stack viejo → `cdk import` | Todo queda en IaC; drift gestionado | `cdk import` no soporta todos los tipos (UserPoolDomain/IdentityPool dudosos); requiere cirugía de Refs en el stack serverless si se hace antes del cutover; más pasos en prod |
| (2) Referencias `fromTableName`/`fromUserPoolId` | Cutover rápido y de mínimo riesgo; cero toque a recursos con datos; client/identity-pool IDs intactos | Stateful fuera de CFN para siempre (config de tablas/pool se gestiona a mano) |
| (3) Mini-stack serverless residual | Casi nada | Mantienes Serverless v3 (EOL) + plugin para siempre; lo peor de ambos mundos — **descartada** |

**RECOMENDACIÓN: híbrido 2→1.** Fase A = opción 2 (CDK nuevo con referencias, coexistiendo con el stack viejo; cutover = repuntar base path mapping, reversible en segundos). Fase B (post-bake) = borrar el stack viejo con Retain y hacer `cdk import` de tablas+bucket+colas+pool+client a un DatabaseStack/AuthStack reales (todos esos tipos soportan import; verificar IdentityPool — si no, queda por referencia, es un ID estático sin config que driftee). Nunca se redeploya Serverless salvo el paso Retain.

## Pasos ordenados (dev primero como ensayo completo, luego prod idéntico)

1. **Baseline**: deploy serverless prod una última vez para alinear repo↔prod (`updateTemplate` falta en prod) — o aceptar el delta y que CDK lo entregue. Snapshot: export de templates CFN actuales + `aws dynamodb describe-table` de las 9 + backups on-demand de las 9 tablas prod + `describe-user-pool` dump.
2. **Retain total**: agregar `DeletionPolicy/UpdateReplacePolicy: Retain` a TODO stateful en serverless.ts (tablas, pools, client, identity pool, domain, colas; bucket ya lo tiene) y deploy dev+prod. Es el seguro de vida de todo lo demás.
3. **Construir CDK** (estructura de arriba): stateful por referencia (`Table.fromTableName('mkpdfs-{env}-users')`, `UserPool.fromUserPoolId`, `UserPoolClient.fromUserPoolClientId`, `Bucket.fromBucketName`, `Queue.fromQueueArn`, `LayerVersion.fromLayerVersionArn(...mkpdfs-chromium:1)`). API nueva REGIONAL (el edge lo pone el custom domain existente). Misma var-env surface para los handlers.
4. **Deploy CDK a dev** en paralelo al stack viejo. Gotchas: (a) NO crear aún los event source mappings SQS o crearlos `enabled:false` — si no, lambdas nuevas y viejas compiten por mensajes; (b) triggers Cognito sobre pool importado = `CustomResource`/CLI `update-user-pool` apuntando al pool **ACTIVO** us-east-1_W7zAXUV7k — esto además ARREGLA el bug de triggers-en-pool-fantasma; (c) la cola y DLQ siguen siendo las viejas (referenciadas).
5. **Smoke dev contra execute-api URL nueva**: login Cognito real, generatePdf, v1/pdf/generate con token tlfy, stripe webhook (firma test), marketplace público, job async end-to-end (habilitando el mapping nuevo y deshabilitando el viejo: `aws lambda update-event-source-mapping --enabled`).
6. **Cutover dominio dev** (sin downtime): `aws apigateway update-base-path-mapping --domain-name dev.apis.mkpdfs.com --base-path '(none)' --patch-operations op=replace,path=/restapiId,value=<nuevo>,op=replace,path=/stage,...` — una sola llamada, el CloudFront del dominio no cambia, DNS no cambia, cert no cambia. **Rollback = la misma llamada con el restApiId viejo (a6njd1d2rh/9t7amf2ofc), <1 min.** En CDK, el mapping se adopta después con `DomainName.fromDomainNameAttributes` + `CfnBasePathMapping` (o se deja gestionado por runbook).
7. **Bake dev 2-3 días** (tráfico real + alarmas DLQ/5XX). Apagar event source mappings y triggers del stack viejo dev.
8. **Repetir 4-7 en prod** (gh workflow_dispatch, mano humana). Stripe no requiere cambio (webhook URL = mismo dominio). Pre-cutover: drenar colas (depth 0) en ventana de bajo tráfico al flip de los mappings SQS.
9. **Decomisionar viejo (Fase B)**: confirmar que el base path mapping y el domain NO están en el stack CFN viejo (el plugin los crea por API — verificar con `detect-stack-drift`/template); borrar pools duplicados us-east-1_hsVNQxLrh y us-east-1_y3O32FfRc (re-verificar 0 usuarios); `aws cloudformation delete-stack mkpdfs-api-{stage}` → stateful queda huérfano por Retain; lambdas/API/rol viejos mueren.
10. **`cdk import`** de huérfanos a DatabaseStack/StorageStack/JobsStack/AuthStack (cambiar `fromXxx` → constructos owned con `RemovalPolicy.RETAIN`, `cdk import` por stack, luego `cdk diff` = vacío). Dev primero.
11. **CI/CD**: reemplazar deploy.yml por el patrón del skill (OIDC ya existe — reusar `AWS_ROLE_ARN_*`; quitar el paso layers/puppeteer roto; `cdk diff` + `cdk deploy --all -c environment=…`; prod gateado por environment `production`). ci.yml: + `cdk synth` + snapshot tests.

## Qué se deja de usar → reemplazo

| Se va | Lo reemplaza |
|---|---|
| serverless v3 + @serverless/typescript | aws-cdk-lib + bin/lib |
| serverless-esbuild | NodejsFunction (esbuild local, `forceDockerBundling:false`, exclude @sparticuz) |
| serverless-domain-manager | DomainName/BasePathMapping existentes adoptados por referencia (+ runbook de repunte); dominio/Route53 NO se recrean |
| serverless-offline | `cdk watch` + vitest de handlers (nada equivalente 1:1; documentar) |
| evento `cognitoUserPool existing:false` | triggers sobre el pool real (custom resource o import) — fix del bug de pool duplicado |
| `${ssm:}` deploy-time | SSM runtime con caché (secrets fuera del env) |
| Rol IAM único | grants por función (mínimo privilegio) |
| Deployment bucket de Serverless | assets de CDK (bootstrap existente o `cdk bootstrap`) |

## Riesgos principales

1. **Pool duplicado**: cualquier plan que toque `cognitoUserPool events` puede borrar el pool con triggers o el activo — el Retain del paso 2 protege; el fix de triggers es parte del cutover, no opcional (hoy postConfirmation no corre: usuarios sin row en users-table posible — auditar las 4 cuentas prod).
2. **Colisión de consumidores SQS** durante coexistencia → mappings nuevos nacen disabled.
3. **CORS**: al quitar los OPTIONS MOCK del plugin, el preflight depende de GatewayResponses + Middy httpCors — probar preflight desde mkpdfs.com ANTES del cutover de dominio.
4. **`cdk import` no probado en este stack** → por eso va en Fase B post-cutover, con dev como ensayo y rollback trivial (no importar = quedarse en referencias, estado totalmente operable).
5. **Workflow deploy.yml ya está roto** (layers/ inexistente) — los deploys actuales son manuales; cualquier "rollback redeployando serverless" debe ser local, validar que `serverless deploy` aún corre antes de empezar.
6. Client ID / IdentityPool ID / Hosted UI domain horneados en frontend — jamás recrear; todo el plan los deja físicamente intactos.
7. `reservedConcurrency` (10/5) y timeouts/mem deben copiarse exactos (tabla (a) es la spec); stage name del deployment CDK debe coincidir en el base path mapping.

---

Archivos clave del inventario: `serverless.ts`, `src/resources/{dynamodb,cognito,s3,sqs,apigateway}.ts`, `src/functions/index.ts` + 32 `index.ts` por función, `.github/workflows/{ci,deploy}.yml`.

## Enmiendas (review Codex — obligatorias para Fase A)

1. **CORS preflight real**: Middy httpCors + GatewayResponses NO sustituyen el método OPTIONS. En CDK: `defaultCorsPreflightOptions` en el RestApi (o `addCorsPreflight` por resource) replicando los headers del plugin (Authorization, Content-Type, x-api-key) — GatewayResponses solo para errores 4XX/5XX. Probar preflight desde mkpdfs.com ANTES del cutover.
2. **Fix de triggers Cognito merge-safe**: el CustomResource hace `describe-user-pool` del pool ACTIVO, reenvía la config existente completa (MFA, advanced security, recovery, políticas) y SOLO cambia `LambdaConfig`; + `lambda:AddPermission` para `cognito-idp.amazonaws.com` con SourceArn del pool. Dump before/after guardado; dev primero.
3. **Self-invoke por nombre físico**: `generatePdf` invoca `${SERVICE_NAME}-${STAGE}-generatePdfAsync` hardcodeado (src/functions/pdf/generate/handler.ts:56) — reemplazar por env `GENERATE_PDF_ASYNC_FUNCTION_NAME` inyectada por CDK (o retirar el path async:true deprecated en el mismo cambio).
4. **Colas por referencia**: inyectar `PDF_GENERATION_QUEUE_URL`/`AI_GENERATION_QUEUE_URL` desde las colas referenciadas — jamás depender del fallback con account hardcodeado de los producers.

## PIVOTE (decisión del owner: mkpdfs NO tiene usuarios reales)

La estrategia híbrida 2→1 queda SUPERSEDIDA. Nueva estrategia: **CDK dueño de todo** (greenfield con mismos nombres físicos):

1. Backup barato pre-borrado: `dy export` de las 9 tablas por stage (datos = cuentas de prueba + servicio) + `aws s3 sync` de los buckets a un prefijo de respaldo local/S3 (preservar `lambda-layers/chromium-v143...zip`).
2. `aws cloudformation delete-stack mkpdfs-api-{stage}` (dev primero; el bucket tiene Retain → vaciarlo/borrarlo aparte para liberar el nombre).
3. `cdk deploy` crea TODO: tablas/colas con los MISMOS nombres físicos, pool+client+identity+hosted-domain NUEVOS (los IDs cambian — aceptado), buckets mismos nombres, RestApi + **DomainName/BasePathMapping gestionados por CDK** (ya no hay runbook manual de cutover: el dominio custom y el record Route53 existentes se adoptan/recrean desde CDK), triggers Cognito DIRECTOS en el pool (ya no CustomResource merge-safe — el pool es nuestro; el bug del pool fantasma muere de raíz).
4. Re-provisioning: `provision-mkpdfs.mjs` (idempotente) recrea cuenta de servicio/enterprise/token/templates → SSM actualizado; democonnect: cdk.json con templateIds nuevos + CI.
5. mkpdfs-web: actualizar env (POOL_ID/CLIENT_ID/IDENTITY_POOL) y redeploy.
6. Layer chromium: re-subir el zip respaldado y republicar si hiciera falta (o conservar la layer actual — las layers NO viven en el stack, sobreviven).
7. Lo que se simplifica: sin `cdk import`, sin coexistencia SQS (stack viejo muere antes), sin runbook de repunte de dominio, sin enmienda 2 (CustomResource merge-safe innecesario — triggers nativos CDK).
8. Lo que se mantiene del plan: estructura de stacks, NodejsFunction/esbuild, grants por función, SSM runtime, CORS preflight real (enmienda 1), GENERATE_PDF_ASYNC_FUNCTION_NAME (enmienda 3), queue URLs inyectadas (enmienda 4), CI OIDC nuevo.

### Contratos del runbook greenfield (review Codex del pivote)

1. **Buckets versionados**: `aws s3 rm --recursive` NO libera el nombre — purgar con `list-object-versions` borrando `Versions` Y `DeleteMarkers` antes de que CDK recree el bucket homónimo.
2. **Dominios**: el plugin los creó FUERA de CFN — el runbook los borra explícitamente (domain + base path + records A/AAAA) ANTES de `cdk deploy`, aceptando la ventana de indisponibilidad (sin usuarios) y la propagación CloudFront del dominio nuevo (~20-40 min). Ensayo completo en dev primero.
3. **Dependientes como pasos BLOQUEANTES del runbook** (no post-tarea): CDK emite CfnOutputs JSON (poolId/clientId/identityPoolId/apiUrl) → `provision-mkpdfs.mjs` parametrizado para LEER pool/client por flag/outputs (hoy hardcodeados) → re-provision → actualizar SSM + templateIds en democonnect cdk.json + redeploy democonnect → actualizar env de mkpdfs-web + redeploy Amplify. Smoke de PDF end-to-end cierra el runbook.
4. **Rollback explícito**: sin flip rápido (el stack viejo muere primero). Prod solo arranca con: ensayo dev completo verde, backups verificados (dy export + s3 sync), `cdk synth` + change set revisado. Restauración = redeploy serverless desde git (validar que aún corre ANTES de borrar nada) + re-provision.

### Lección del ensayo dev
- El runbook debe borrar TAMBIÉN los records A/AAAA de Route53 del dominio (el plugin los creó fuera de CFN); borrar solo el domain name de API Gateway deja los records y el Api stack rollbackea al crear los alias.
