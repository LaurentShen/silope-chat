# SILOPE Chat · 第一版

可自行部署的私人即时通讯站点。包括管理员安装向导、统一登录入口、一对一文字/照片/语音留言/文件聊天、浏览器实时语音和视频通话、账户管理与外观设置。默认风格取自你提供的 SILOPE HTML：酒红色 `#560c30`、浅色背景和 Logo 高度 38px。

## 快速部署（Ubuntu / Debian + Docker Compose）

1. 将整个目录上传到服务器；安装 Docker Engine 和 Compose 插件。
2. `cp .env.example .env`，将 `.env` 的 `POSTGRES_PASSWORD` 改为一个长随机值；按需要修改 `DOMAIN` 和 `APP_ORIGIN`。`APP_ORIGIN` 必须是浏览器访问的准确源地址，如 `https://chat.silope.com`（无尾部斜杠）。
3. 将 `chat.silope.com` 的 DNS A/AAAA 记录指向服务器。开放 TCP 80/443 与 UDP 443，保证 Caddy 可签发证书。若已有反向代理，不启动 `caddy` 服务，用它转发到 `127.0.0.1:3000`，必须支持 WebSocket 并保持 HTTPS。
4. 在目录内运行 `docker compose up -d --build`，随后运行 `docker compose logs app`。日志会显示仅首次安装使用的随机安装口令。
5. 访问 `https://chat.silope.com/install`，填写安装口令并设置站点名称、主题、Logo 等。安装成功页面会显示 `admin` 和自动生成的随机密码，**当场保存**。以后所有未登录访客访问站点都会看到同一个登录页。由管理员在设置中创建普通账户。

如果使用 Cloudflare Tunnel：自行创建指向本机 `http://127.0.0.1:3000` 的 public hostname，保持 `.env` 中 `APP_ORIGIN=https://chat.silope.com`，运行 `docker compose up -d --build db app`（无需 Caddy）。确认 Tunnel 的 WebSocket 支持已启用。安装口令通过 `docker compose logs app` 获取。

## 功能及边界

- 所有账户由管理员创建；管理员可以改所有用户及自己的用户名和密码、删除普通用户。更改密码会撤销该账户所有现有会话。删除普通用户也会删除其消息；关联文件不会自动清理，后续版本可增加后台清理任务。
- 文字和附件可实时送达，离线后登录仍可查看最近消息；上滚按每页 50 条载入历史。单个附件上限 25 MiB；图片和音频可内嵌播放，其他文件以下载方式提供。附件只有上传者和消息双方可访问。可通过浏览器麦克风录制语音留言。
- 一对一实时语音／视频依赖 WebRTC 和浏览器的麦克风／摄像头权限。必须使用 HTTPS（本机 localhost 除外）。双方需要同时在线，并保持页面打开。没有呼叫记录、推送通知或群聊。
- 默认没有配置 TURN；在部分运营商网络、公司网络和严格 NAT 下可能出现有铃声却无法接通或没有媒体。上线前建议部署 coturn 等 TURN 服务，配置其 HTTPS 下可用的 `turns:` URL。示例：

  ```env
  ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turns:turn.example.com:5349","username":"your-user","credential":"your-password"}]
  ```

  如果设置静态 TURN 密码，该密码会发给已经登录的浏览器。建议独立的 TURN 账户、限制流量，并在下一版改为短期凭据。WebRTC 音视频传输会使用 DTLS-SRTP；消息保存在服务器数据库中，**此版本没有端到端加密**。
- 目前一个 app 实例处理实时 Socket.IO 事件；PostgreSQL 可以持久化数据，但直接扩为多个 app 实例需要增加 Socket.IO 共享适配器、呼叫占用管理和跨实例事件处理。
- 站点可改浅色／深色、主题色、Logo URL、显隐、高度及原色／白色／深色模式。远程 Logo URL 仅允许 HTTPS；默认字体使用系统字体。

## 管理维护

- 备份数据库：`docker compose exec -T db pg_dump -U silope_chat silope_chat > backup.sql`。同时备份 Docker volume `appdata`（上传文件）与 `.env`。数据库和附件必须一起恢复。
- 更新：先备份，再在目录中替换代码并运行 `docker compose up -d --build`。数据库启动时创建缺失表；本版尚未提供复杂迁移框架。
- 查看状态：`docker compose ps`、`docker compose logs -f app`。
- 为安全起见，请在上线前用最新依赖重建镜像，及时更新 Docker 与主机，并在生产环境限制备份和日志访问权限。

## 技术结构

Node.js 22、Express、Socket.IO、WebRTC、PostgreSQL 16、Argon2 密码散列、服务器端会话 Cookie、受保护的本地附件、Caddy HTTPS。站点源码位于 `public/`，API 与数据库逻辑位于 `server.js`。用户表、会话表、消息表、附件表和设置表在首次启动时自动创建。
