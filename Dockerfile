FROM node:alpine as builder

WORKDIR /app/auto-merge/

RUN apk add --no-cache --virtual .gyp python3 make g++

COPY ./package*.json ./

RUN npm install


FROM node:alpine as app

WORKDIR /app/auto-merge/

COPY --from=builder /app/auto-merge/node_modules/ ./node_modules/
COPY . ./

RUN npm run build

EXPOSE 3000

ENTRYPOINT [ "npm", "start" ]
