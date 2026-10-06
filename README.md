# LAIN Studio / Store

Sitio HTML/CSS/JavaScript con un backend Express pequeño para catálogo, carrito,
checkout y órdenes internas. El backend de Mercado Pago existe en modo test, pero
su integración frontend y validación final permanecen pendientes.

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
machine y el webhook ya existen en backend para el entorno de test. El storefront
todavía no ofrece un formulario de pago: falta validar la integración frontend y
el recorrido E2E antes de conectarlos al checkout.

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
rollback y luego migrate. Las pruebas PostgreSQL nunca leen `DATABASE_URL`:

```sh
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/lain_store_test npm run test:postgres
```

El schema persiste `orders`, `order_items`, `idempotency_keys` y
`payment_attempts`. Todos los montos son `BIGINT` en minor units. Creación de
orden + items + idempotencia ocurre en una transacción. Las actualizaciones de
orden usan `version` como optimistic concurrency control; los claims de pago
usan transacción y `SELECT ... FOR UPDATE` sobre la orden.

## Mercado Pago — solo test

La integración permanece deshabilitada con `PAYMENT_PROVIDER=none`. Para usar
credenciales de prueba:

```sh
PAYMENT_PROVIDER=mercadopago
PAYMENT_ENV=test
MP_ACCESS_TOKEN=<test access token, solo backend>
MP_PUBLIC_KEY=<test public key>
MP_WEBHOOK_SECRET=<test webhook secret>
MP_NOTIFICATION_URL=https://example.test/api/webhooks/mercadopago
```

El proceso falla al iniciar si `PAYMENT_ENV` no es exactamente `test`. El Access
Token y el secret nunca se envían al browser; `/api/payments/config` expone solo
la Public Key. No se carga actualmente el SDK de Mercado Pago en el storefront.

```text
internal order -> durable payment_attempt -> MercadoPagoProvider
-> provider result/webhook -> OrderService state policy -> PostgreSQL
```

Cada `payment_attempt` usa su UUID persistido como `X-Idempotency-Key` frente a
Mercado Pago. Un timeout queda `processing`; un retry no vuelve a crear el pago.
El webhook firmado consulta `/v1/payments/:id` server-side antes de reconciliar.

Endpoints:

- `POST /api/orders/:id/payments`: inicia o recupera el intento idempotente.
- `GET /api/payments/config`: entrega configuración pública de test.
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
