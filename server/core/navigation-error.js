'use strict';

/**
 * 对应原版 src/indexing/document_navigator.py 中的 NavigationError。
 * 表示“无效或有歧义的导航请求”，由工具层转换为 success=false + error 文案。
 */
class NavigationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NavigationError';
  }
}

module.exports = { NavigationError };
