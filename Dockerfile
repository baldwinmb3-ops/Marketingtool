FROM node:20-alpine

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=4173

COPY scripts/serve-html.mjs ./scripts/serve-html.mjs
COPY premium_pricing_clickable.html ./premium_pricing_clickable.html
COPY runtime-config.js ./runtime-config.js
COPY manifest.webmanifest ./manifest.webmanifest
COPY *.jpg ./
COPY *.png ./
COPY *.svg ./

EXPOSE 4173

CMD ["node", "scripts/serve-html.mjs"]
