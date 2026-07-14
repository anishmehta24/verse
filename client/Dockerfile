# syntax=docker/dockerfile:1

# ---- Build stage: produce the static CRA bundle ----
FROM node:20-slim AS build
WORKDIR /app
# .npmrc carries legacy-peer-deps=true (react-scripts 5 vs TypeScript 5).
COPY package*.json .npmrc ./
RUN npm install
COPY . .
# CRA inlines REACT_APP_* at BUILD time, so the API URL is baked in here.
ARG REACT_APP_API_URL=http://localhost:3001/
ENV REACT_APP_API_URL=$REACT_APP_API_URL
# CI=false so build warnings are not treated as errors.
RUN CI=false npm run build

# ---- Runtime stage: serve static files with nginx ----
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
