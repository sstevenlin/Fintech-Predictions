# Backend

expres + typescript backend

- node 22
- express
- postgres via prisma
- pino for logging

## how to run

```sh
# from root
npm i

# copy env file and fill in values
cp backend/.env.example backend/.env

# start dev server on http://localhost:3000
npm run dev
```

## env vars

- `PORT` - server port (default: 3000)
- `DATABASE_URL` - postgres connection string
- `NODE_ENV` - `development` or `production`

## api

check `API.md` for api documentation
