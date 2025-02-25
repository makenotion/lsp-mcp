FROM node:20 AS builder

RUN mkdir /app
RUN npm install -g typescript

WORKDIR /app

COPY package.json .
COPY yarn.lock .
RUN yarn install --frozen-lockfile --ignore-scripts

COPY . .
RUN yarn build

FROM node:20
WORKDIR /app
COPY --from=builder /app/dist /app
COPY --from=builder /app/node_modules /app/node_modules
