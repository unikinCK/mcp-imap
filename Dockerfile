FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
# Of pdf.js only the font and CMap data are used at runtime, of the OCR language data only the LSTM models.
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev \
 && rm -rf node_modules/pdfjs-dist/build node_modules/pdfjs-dist/legacy node_modules/pdfjs-dist/web \
           node_modules/pdfjs-dist/types node_modules/pdfjs-dist/image_decoders \
           node_modules/@tesseract.js-data/*/4.0.0

FROM node:24-alpine
ENV NODE_ENV=production \
    MCP_IMAP_HTTP_HOST=0.0.0.0 \
    MCP_IMAP_HTTP_PORT=3000 \
    MCP_IMAP_DB=/data/mcp-imap.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
