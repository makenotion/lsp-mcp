FROM node:20 AS builder
RUN mkdir /app
RUN npm install -g typescript
WORKDIR /app
COPY . .
RUN yarn --frozen-lockfile

FROM node:20
WORKDIR /app
COPY --from=builder /app/dist /app
COPY --from=builder /app/node_modules /app/node_modules
