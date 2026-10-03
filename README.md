# Grove

Grove is a 2D multiplayer game platform for students, where younger creators build games with blocks and older ones write TypeScript against the same API. Games run on one deterministic TypeScript engine that drives the editor's live preview in the browser and runs inside Rust game processes on an EC2 fleet scheduled by Go services.

```mermaid
flowchart LR
  platform["Platform<br/>TypeScript, React"] --> api["API<br/>TypeScript, Fastify"]
  editor["Editor<br/>TypeScript, React"] --> api
  editor --> s3[("Amazon S3")]
  player["Player<br/>TypeScript, React"] --> gameinstance["Game Instance<br/>Rust, Axum"]
  playground["Playground<br/>TypeScript, React"]
  api --> postgres[("PostgreSQL")]
  api --> redis[("Redis")]
  api --> s3
  api --> servermanager["Server Manager<br/>Go"]
  gamebuilder["Game Builder<br/>TypeScript, Fastify"] --> redis
  gamebuilder --> api
  assetupload["Asset Upload Service<br/>Rust, Axum"] --> redis
  assetupload --> api
  servermanager --> redis
  servermanager --> api
  servermanager --> instancemanager["Instance Manager<br/>Go"]
  instancemanager --> servermanager
  instancemanager --> gameinstance
  instancemanager --> cloudfront["Amazon CloudFront"]
  cloudfront --> s3
  gameinstance --> gamemanager["Game Manager<br/>Go"]
```
