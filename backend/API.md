# API Contract v1

## Auth

### `POST /auth/signup`

```json
// Request
{
  "email": "string",
  "password": "string"
}

// Response 201
{
  "token": "string",
  "user": {
    "id": "string",
    "email": "string"
  }
}
```

### `POST /auth/login`

```json
// Request
{
  "email": "string",
  "password": "string"
}

// Response 200
{
  "token": "string",
  "user": {
    "id": "string",
    "email": "string"
  }
}
```

### `POST /auth/logout`

```
// Request: Authorization: Bearer <token>
// Response 204: No content
```

---

## Markets

### `GET /markets`

List all available markets across Kalshi and Polymarket.

```
// Query params
?source=kalshi|polymarket   // filter by source (optional)
?status=open|closed         // filter by status (optional)

// Response 200
{
  "markets": [
    {
      "id": "string",
      "title": "string",
      "source": "kalshi" | "polymarket",
      "probability": number,   // 0–1
      "status": "open" | "closed" | "resolved",
      "expiresAt": "string"    // ISO 8601
    }
  ]
}
```

### `GET /markets/:id`

Get detail for a single market.

```json
// Response 200
{
  "id": "string",
  "title": "string",
  "source": "kalshi" | "polymarket",
  "probability": number,
  "status": "open" | "closed" | "resolved",
  "expiresAt": "string",
  "priceHistory": [
    { "probability": number, "timestamp": "string" }
  ]
}
```

---

## Orders

> Paper trades only for v1 — market orders, instant simulated fills, no partial fills

### `POST /orders`

Place a paper trade.

```
// Request: Authorization: Bearer <token>
```

```json
// Request body
{
  "marketId": "string",
  "side": "yes" | "no",
  "quantity": number
}

// Response 201
{
  "id": "string",
  "marketId": "string",
  "side": "yes" | "no",
  "quantity": number,
  "price": number,       // fill price at time of order
  "status": "filled",
  "createdAt": "string"
}
```

### `GET /orders`

List the authenticated user's orders.

```
// Request: Authorization: Bearer <token>

// Response 200
{
  "orders": [ ...order objects ]
}
```

---

## Portfolio

### `GET /portfolio`

Get the authenticated user's positions and PnL.

```
// Request: Authorization: Bearer <token>

// Response 200
{
  "positions": [
    {
      "marketId": "string",
      "marketTitle": "string",
      "side": "yes" | "no",
      "quantity": number,
      "avgPrice": number,
      "currentPrice": number,
      "pnl": number
    }
  ],
  "totalPnl": number
}
```

---

## Errors

All errors follow this shape:

```json
{
  "error": "string"
}
```

| Status | Meaning                        |
| ------ | ------------------------------ |
| 400    | Bad request / validation error |
| 401    | Unauthenticated                |
| 404    | Not found                      |
| 500    | Internal server error          |
