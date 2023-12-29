FROM --platform=linux/amd64 node:18.15.0-alpine3.17
WORKDIR /app
ADD ./package.json .
RUN npm i
ADD ./index.js .
CMD [ "npm", "start" ]