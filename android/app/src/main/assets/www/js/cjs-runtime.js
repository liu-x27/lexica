'use strict';
/**
 * 极小的 CommonJS 运行时 + node 内置模块桩。
 *
 * 目的是让 src/main 下的 dict-db.js / user-db.js / quiz.js 原样跑在 WebView 里。
 * 那三个文件是主进程模块，顶上写着 require('node:fs') 之类；与其为安卓端另抄一份
 * （抄了就一定会和桌面端漂移），不如把它们需要的那几个 node API 补上。
 *
 * 只补真正被用到的调用，不做通用 polyfill——缺什么在这里加，别让它悄悄退化成假实现。
 */
(function (g) {
  const registry = Object.create(null);   // 模块 id -> exports
  const factories = Object.create(null);  // 模块 id -> 工厂函数

  /* ---- node 内置模块的桩 ---- */

  registry['node:path'] = {
    // 安卓内部存储路径一律是 POSIX 风格
    join: (...parts) => parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
    basename: (p) => String(p).split('/').pop(),
    dirname: (p) => String(p).split('/').slice(0, -1).join('/') || '/',
  };

  registry['node:fs'] = {
    // 目录由 Activity 侧建好（filesDir 一定存在），这里只需要不报错
    mkdirSync: () => {},
    // dict-db.js 用它判断词库在不在；能走到这一步说明 Activity 已经拷好并打开了
    existsSync: () => true,
  };

  registry['node:sqlite'] = {
    get DatabaseSync() { return g.AndroidSQLite.DatabaseSync; },
  };

  function require(id) {
    if (id in registry) return registry[id];
    // 相对路径按文件名索引：'./dict-db' 与 './dict-db.js' 视为同一个
    const key = String(id).replace(/^\.\//, '').replace(/\.js$/, '');
    if (key in registry) return registry[key];
    if (key in factories) {
      const module = { exports: {} };
      registry[key] = module.exports;          // 先占位，容忍循环依赖
      factories[key](module, module.exports, require);
      registry[key] = module.exports;
      return registry[key];
    }
    throw new Error(`[cjs] 找不到模块：${id}`);
  }

  /** 构建脚本为每个源文件生成一次调用 */
  function define(name, factory) {
    factories[name] = factory;
  }

  g.__cjs = { require, define, registry };
})(globalThis);
