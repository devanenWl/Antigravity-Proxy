#
# Single-container build:
# - Build Vue frontend into /app/frontend/dist
# - Build Node backend deps (including better-sqlite3 native addon)
# - Runtime runs only the backend, which serves /frontend/dist via @fastify/static
#

FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine AS backend-builder
WORKDIR /app/backend
# build deps for better-sqlite3
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./

FROM node:20-alpine AS runtime
WORKDIR /app

# backend (code + production deps)
COPY --from=backend-builder /app/backend /app/backend

# frontend dist (served by backend)
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

# persistent data directory (bind-mounted in compose)
RUN mkdir -p /app/data

EXPOSE 3000
WORKDIR /app/backend
CMD ["node", "src/bootstrap.js"]
