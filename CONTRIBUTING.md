# 贡献指南

欢迎提交可复现的问题、文档修正和功能改进。请先用虚构样例描述场景，再说明预期结果与实际结果。

## 开发与检查

本地使用 Node.js 22 或 24。根目录测试不需要安装依赖。

```bash
npm test
npm run check
npm run release:check
```

修改共享核心后，先运行 `npm run sync`。新增业务规则时补充能覆盖失败路径的测试。云函数 SDK 可通过 `npm ci --ignore-scripts --prefix cloudfunctions/api` 安装；安装后可执行 `npm audit --omit=dev --prefix cloudfunctions/api`。

## 提交变更

1. Fork 仓库并建立功能分支。
2. 保持一次提交聚焦一个明确问题，附上触发条件与测试方式。
3. 提交前检查 `git diff --cached`，确认不含真实用户信息、环境标识或本地配置。
4. 创建 Pull Request，说明行为变化和仍未验证的部分。

使用 GitHub 提供的 noreply 邮箱和公开昵称提交；真实姓名、电话、私人邮箱无需写入源码。不要提交 `node_modules`、`.env`、个人调试配置、数据导出或开发工具截图。

## 功能方向

优先处理真机联调、数据库索引与分页、图片审核与清理、资料删除流程和完整部署示例。新增定位、支付或其他服务前，需要同时设计服务端授权、异常处理和对应的平台配置。

请勿提交真实订单数据；涉及漏洞时遵循 [安全说明](SECURITY.md)。
