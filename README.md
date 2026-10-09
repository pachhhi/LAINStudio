# LAIN Studio / Store

Sitio HTML/CSS/JavaScript con un backend Express pequeño para catálogo, carrito,
checkout y órdenes internas. Mercado Pago está integrado con Card Payment Brick
y Checkout API Orders, con selección explícita entre test y producción.

## Ejecutar

```sh
npm install
npm start
```

Abrir `http://localhost:3000`. Para ejecutar las pruebas:

```sh
npm test
```

La suite HTTP usa Supertest y puede requerir permiso para abrir sockets locales
efímeros en entornos sandbox. Cobertura: `npm run test:coverage`.

## Arquitectura comercial

- `products.js`: catálogo compartido. El navegador lo usa para presentar los
  productos y el servidor lo usa como fuente autoritativa de precios.
- `catalog.js`: navegación y renderizado de catálogo, ficha y panel del carrito.
- `cart-store.js`: persistencia local y tolerancia a errores de `localStorage`.
- `cart-service.js`: validación y operaciones del carrito, sin dependencias del DOM.
- `checkout.html`, `checkout.js`, `checkout.css`: resumen, datos del comprador y
  creación de una orden interna. Nunca envían precios al servidor.
- `server/catalog`: resolución server-side de producto, variante, precio y moneda.
- `server/orders`: modelo, state machine y contrato con implementaciones en
  memoria y PostgreSQL.
- `server/payments/payment-provider.js`: contrato del futuro proveedor de pagos.
- `server/app.js`: API y archivos estáticos.

Flujo actual:

```text
Catalog -> Cart (localStorage) -> Checkout -> POST /api/checkout
        -> validate against catalog -> internal order (pending)
```

En runtime, órdenes, items, claves idempotentes e intentos de pago se guardan en
PostgreSQL. El repositorio en memoria se utiliza únicamente en pruebas unitarias.

## API interna

- `POST /api/checkout`: prepara una orden interna desde checkout.
- `POST /api/shipping/quotes`: cotiza métodos de envío para el carrito.
- `GET /api/public/orders/:publicOrderId`: entrega una confirmación sanitizada,
  sin datos del comprador ni dirección.

El cuerpo de creación contiene únicamente items (`productId`, `variantId`,
`color`, `quantity`) y datos básicos del comprador. Cualquier precio enviado por
el cliente se ignora; subtotal y total siempre se calculan usando el catálogo del
servidor.

## Próxima integración de pagos

El contrato, el adaptador de Mercado Pago, la persistencia de intentos, la state
machine y el webhook existen en backend para el entorno de test. El storefront
carga Card Payment Brick desde el SDK oficial, obtiene sólo la Public Key desde
el backend y envía el token resultante al endpoint de pagos. Falta validar el
recorrido E2E con credenciales y tarjetas TEST reales.

No deben agregarse credenciales al repositorio; `.env.example` contiene solamente
valores ilustrativos.

## PostgreSQL

Runtime utiliza `PostgresOrderRepository`; `InMemoryOrderRepository` se conserva
para tests unitarios. Se requiere PostgreSQL y dos bases separadas, por ejemplo:

```sql
CREATE DATABASE lain_store_dev;
CREATE DATABASE lain_store_test;
```

Copiar `.env.example` a `.env` o exportar las variables sin guardar credenciales:

```sh
export DATABASE_URL=postgresql://user:password@localhost:5432/lain_store_dev
export TEST_DATABASE_URL=postgresql://user:password@localhost:5432/lain_store_test
npm run db:migrate
npm start
```

Migraciones:

```sh
npm run db:migrate
npm run db:rollback
```

`db:rollback` revierte la última migración en `DATABASE_URL`; no debe apuntar a
producción durante desarrollo. Para resetear la base de desarrollo, ejecutar
rollback y luego migrate.

Las pruebas PostgreSQL usan exclusivamente `TEST_DATABASE_URL`. Puede guardarse
en un `.env.test` local tomando `.env.test.example` como plantilla. El setup
rechaza nombres de base que no contengan `test`, rechaza la misma URL que
`DATABASE_URL`, intenta crear la base si no existe y aplica las migraciones:

```sh
npm run test:postgres
npm run test:all
```

`npm test` ejecuta solamente la suite sin PostgreSQL. `npm run test:all` es el
comando completo y no permite que los tests PostgreSQL queden omitidos.

El schema persiste `orders`, `order_items`, `idempotency_keys` y
`payment_attempts`. Todos los montos son `BIGINT` en minor units. Creación de
orden + items + idempotencia ocurre en una transacción. Las actualizaciones de
orden usan `version` como optimistic concurrency control; los claims de pago
usan transacción y `SELECT ... FOR UPDATE` sobre la orden.

## Mercado Pago — test y producción

La integración permanece deshabilitada con `PAYMENT_PROVIDER=none`. El entorno
se selecciona explícitamente con `PAYMENT_ENV=test|production`. Para pruebas se
aceptan las variables históricas mostradas abajo; también pueden usarse sus
equivalentes `MERCADOPAGO_TEST_*` y `MP_TEST_WEBHOOK_SECRET`:

```sh
PAYMENT_PROVIDER=mercadopago
PAYMENT_ENV=test
MERCADOPAGO_ACCESS_TOKEN=<test access token, solo backend>
MERCADOPAGO_PUBLIC_KEY=<test public key>
MP_WEBHOOK_SECRET=<test webhook secret>
MP_NOTIFICATION_URL=https://example.test/api/webhooks/mercadopago
```

Producción exige variables separadas y no reutiliza credenciales genéricas:

```sh
PAYMENT_PROVIDER=mercadopago
PAYMENT_ENV=production
MERCADOPAGO_PRODUCTION_ACCESS_TOKEN=<production access token, solo backend>
MERCADOPAGO_PRODUCTION_PUBLIC_KEY=<production public key>
MP_PRODUCTION_WEBHOOK_SECRET=<production webhook secret>
```

El Access Token y el secret nunca se envían al browser; `/api/payments/config`
expone sólo la Public Key y el entorno activo. El storefront carga el SDK oficial
para Card Payment Brick.
El checkout actual admite exclusivamente tarjetas de crédito. El Brick entrega
el token, `payment_method_id`, `issuer_id` y cuotas; el backend fija y valida
`payment_method.type=credit_card`. Débito y prepaga se rechazan explícitamente
en lugar de clasificarse como crédito. En esta etapa la allowlist es `visa`,
`master` y `amex`; debe ampliarse deliberadamente al habilitar otros métodos.

```text
internal order -> durable payment_attempt -> MercadoPagoProvider
-> provider result/webhook -> OrderService state policy -> PostgreSQL
```

Cada `payment_attempt` usa su UUID persistido como `X-Idempotency-Key` frente a
Mercado Pago. Un timeout queda `processing`; un retry no vuelve a crear el pago.
La reconciliación server-side consulta `/v1/orders/:id` y usa los IDs `ORD…` y
`PAY…` persistidos por separado.

El backend ejecuta además una reconciliación al iniciar y cada cinco minutos.
PostgreSQL asigna cada intento mediante `FOR UPDATE SKIP LOCKED` y un lease corto,
por lo que dos procesos no consultan simultáneamente el mismo pago. Si el timeout
ocurrió antes de guardar el ID `ORD…`, se busca la order por el UUID del intento
en `external_reference` dentro de una ventana temporal y luego se confirma por
ID. Nunca se repite automáticamente el `POST /v1/orders`. Los pagos aprobados,
parcialmente reembolsados o con contracargo reciente se vuelven a consultar cada
seis horas durante una ventana acotada de 30 días para detectar reembolsos y
reversiones sin degradar un estado final por información atrasada.

Errores 429, 5xx y timeouts usan backoff acotado. Después de ocho fallos, o ante
una discrepancia de referencia, importe o identificadores, el intento queda
marcado para revisión y se emite un log estructurado con el
`paymentAttemptId`, sin tokens. Para operar sin consultar directamente
PostgreSQL, buscar ese ID en los logs y consultar el estado público de la orden;
no existe un endpoint HTTP de reconciliación manual. Cualquier futura acción
administrativa de escritura debe implementarse en LAIN Ops con autenticación
antes de exponerse remotamente.

Endpoints:

- `POST /api/orders/:id/payments`: inicia o recupera el intento idempotente.
- `GET /api/payments/config`: entrega únicamente la Public Key y el entorno activos.
- `POST /api/webhooks/mercadopago`: recibe y verifica notificaciones.

La migración `002_mercadopago_attempts.sql` agrega la idempotency key durable del
provider. No se persisten payloads completos del proveedor ni datos PCI.

## Idempotencia y límites actuales

`POST /api/checkout` requiere `Idempotency-Key`. La clave
se guarda junto con una huella del payload en `idempotency_keys`: un retry
idéntico devuelve la misma orden y una reutilización con otro payload responde
409. El inicio de pagos usa el mismo mecanismo; mientras una llamada está en
curso, todos los retries con la misma clave comparten su promesa. La transición
transaccional a `awaiting_payment`, bajo row lock, impide que otra clave inicie
un segundo pago para la misma orden.

PostgreSQL conserva las claves tras reinicios y coordina múltiples procesos con
constraints, transacciones y row locking. La promesa compartida en Node es solo
una optimización local; la garantía real está en PostgreSQL. Antes de producción
debe añadirse rate limiting delante de `/api`, idealmente en el proxy y también
como middleware.

## ENVIOPACK SETUP

Esta fase solo consulta tarifas a domicilio; no crea envíos, etiquetas, tracking,
webhooks ni automatizaciones post-pago. Los pesos y medidas viven en
`products.js` y deben completarse con datos reales antes de cotizar un producto.

1. Crear una cuenta en Enviopack y obtener la API Key y Secret Key.
2. Configurar el backend:

```sh
ENVIOPACK_API_KEY=<api key>
ENVIOPACK_SECRET_KEY=<secret key>
ENVIOPACK_ENABLED=true
```

3. Reiniciar el backend, entrar al checkout e ingresar provincia y CP.
4. Verificar que aparezcan las cotizaciones reales bajo `SHIPPING METHOD`.

La comprobación live aislada (no forma parte de `npm test`) se ejecuta con:

```sh
npm run test:enviopack-live
```

Las credenciales y el access token nunca se exponen al navegador. Con
`ENVIOPACK_ENABLED=false` o credenciales incompletas, el endpoint responde
`shipping_provider_not_configured` sin inventar tarifas.

## LAIN Ops — local only

LAIN Ops es una aplicación read-only separada del storefront para consultar
órdenes desde la misma base PostgreSQL. No ejecuta migraciones automáticamente.
Primero aplicá las migraciones desde el proceso habitual y luego iniciá Ops:

```sh
npm run db:migrate
npm run ops
```

Abrir únicamente `http://127.0.0.1:4000`. El proceso siempre bindea a
`127.0.0.1`, incluso si se configura otro `OPS_PORT`, y puede ejecutarse al mismo
tiempo que `npm start`. Esta V1 no tiene login porque es localhost-only. Antes de
exponerla remotamente debe agregarse autenticación o una capa como Cloudflare
Access; no debe publicarse tal como está.

La lista muestra una sección específica para intentos que alcanzaron revisión
manual. El detalle de cada orden incluye `provider_order_id`,
`provider_payment_id`, cantidad de fallos y el último código seguro de
reconciliación. Ops no permite cambiar estados ni reintentar pagos.

## Secuencia técnica de release

1. Partir de un commit limpio que incluya todas las migraciones numeradas.
2. Instalar exactamente el lockfile con `npm ci --omit=dev`.
3. Cargar las variables del entorno fuera del repositorio.
4. Ejecutar `npm run db:migrate` una sola vez antes de arrancar la nueva versión.
5. Arrancar `npm start` bajo el supervisor elegido y comprobar el log de salud de PostgreSQL.
6. Arrancar Ops sólo en loopback cuando se necesite, accediendo mediante túnel privado.

El proxy productivo debe terminar HTTPS, forzar la redirección desde HTTP y
aplicar rate limiting. El proveedor de PostgreSQL debe tener backups automáticos
y una restauración verificada. Estas responsabilidades no se implementan dentro
del proceso Node.

## Railway

`railway.json` configura Railpack, instalación reproducible con el lockfile,
migraciones como pre-deploy, `npm start`, reinicio automático y el health check
`/health`. El servidor escucha explícitamente en `0.0.0.0` y utiliza el `PORT`
inyectado por Railway. El health check responde `503` si PostgreSQL no está
disponible y no expone detalles de conexión.

Configurar el servicio web con estas variables, sin guardar sus valores en Git:

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
PAYMENT_PROVIDER=mercadopago
PAYMENT_ENV=test
MERCADOPAGO_TEST_PUBLIC_KEY=<secret variable>
MERCADOPAGO_TEST_ACCESS_TOKEN=<secret variable>
MP_TEST_WEBHOOK_SECRET=<secret variable>
ENVIOPACK_ENABLED=true
ENVIOPACK_API_KEY=<secret variable>
ENVIOPACK_SECRET_KEY=<secret variable>
```

Usar la referencia privada `DATABASE_URL` del servicio PostgreSQL dentro del
mismo proyecto; no configurar `DATABASE_PUBLIC_URL` en la aplicación ni habilitar
el TCP Proxy de la base. La red privada de Railway ya cifra el tráfico interno.

Desplegar inicialmente una sola réplica y mantener desactivado Serverless/App
Sleeping: el reconciliador comienza con el backend, persiste sus leases y estado
en PostgreSQL y necesita que el proceso siga activo para ejecutar el ciclo cada
cinco minutos. Sus locks PostgreSQL permiten agregar otra réplica posteriormente.

Ops no forma parte del proceso web y su bind continúa fijo a `127.0.0.1:4000`.
No crearle dominio público ni mapear ese puerto. Para el primer deployment puede
quedar sin ejecutar; cualquier acceso remoto futuro requiere un túnel o gateway
privado autenticado.
