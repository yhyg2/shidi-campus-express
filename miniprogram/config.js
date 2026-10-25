// 环境配置：导入开发者工具后，基本上只需要改这一个文件。
module.exports = {
  // auto：填了 CLOUD_ENV 就用云开发，没填就用本地演示数据（能点通界面，数据只存在本机）
  // cloud：强制云开发 ｜ local：强制本地演示 ｜ http：连独立服务端（调试用，需要 HTTPS 合法域名）
  DATA_SOURCE: 'auto',

  // 云开发环境 ID：开发者工具 → 云开发 → 设置 → 环境 ID，形如 campus-express-3g0abcd
  CLOUD_ENV: '',

  // 云函数名，与 cloudfunctions 下的目录名一致
  CLOUD_FUNCTION: 'api',

  // http 模式的服务端地址（一般不用填）
  API_BASE: '',

  BRAND: '拾递',
  VERSION: '3.1.0'
};

