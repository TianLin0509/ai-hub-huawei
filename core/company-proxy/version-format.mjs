// CodeAgent 版本号的唯一格式判断（2026-11-09）：真实版本可能带构建后缀，如 1.2615.02.02-01（绿区真机）。
// 5.5.43 在几个文件里各写了只认纯数字的校验，把能用的电脑挡在外面。这里只拦明显不是版本号的文本。
export const SIGNER_VERSION_RE = /^\d+(?:\.\d+){1,5}(?:-[0-9A-Za-z.]+)?$/;
export const isSignerVersion = text => SIGNER_VERSION_RE.test(String(text || ''));
// 比较时用：只看数字部分。
export const baseVersion = text => String(text || '').split('-')[0];
