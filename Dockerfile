FROM node:22-slim

WORKDIR /app

# 零运行时依赖：只复制仓库内代码与发布资源，不执行 npm install。
COPY package.json ./
COPY src ./src
COPY public ./public
COPY deploy ./deploy
COPY scripts ./scripts

ENV NODE_ENV=production
ENV HOST=0.0.0.0

# 实例身份、端口、状态目录与容量限制全部由配置/环境变量注入（见 deploy/configs）。
ENTRYPOINT ["node", "src/server/main.js"]
