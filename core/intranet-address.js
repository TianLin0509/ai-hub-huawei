'use strict';
// 公司内网地址的唯一判断（2026-11-19 反馈黑洞返工）：收件机建议发布的地址、发送端接受的收件地址、收件机放行的网段，三处都用这里，
// 不会出现「收件机建议 7.x、发送端又把它当公网丢掉」。
//   1. 私网与回环（10/8、172.16/12、192.168/16、100.64/10、127/8），沿用 core/lan-pool.js。
//   2. 企业常见自用的 /8（这些段分配给了不上公网的机构，大企业内网常拿来自用；黄区公司 DNS 就在 7.x）。
//      某台电脑只有在「自己的网卡或 DNS 服务器落在其中某段」或「收件设置里明确写了」时，才把那一段当公司内网（companyEights）。
//      发送端不知道收件机那边的配置，按整张名单接受（acceptableIPv4）——收件机建议的地址一定在这张名单里，所以发送端一定认。
//   3. 常见公共 DNS（8.8.8.8、114.114.114.114、223.5.5.5、1.1.1.1、119.29.29.29、180.76.76.76 等）不参与推断。
const { isIP } = require('node:net');
const { isPrivateAddress } = require('./lan-pool');

const ENTERPRISE_EIGHTS = Object.freeze([7, 11, 21, 22, 26, 28, 29, 30, 33, 55]);
const PUBLIC_DNS = Object.freeze(['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9', '149.112.112.112', '208.67.222.222', '208.67.220.220',
  '114.114.114.114', '114.114.115.115', '223.5.5.5', '223.6.6.6', '119.29.29.29', '180.76.76.76', '182.254.116.116', '101.226.4.6', '218.30.118.6']);
const PUBLIC_DNS_PREFIX = Object.freeze(['114.114.', '223.5.5.', '223.6.6.', '119.29.29.', '180.76.76.']);

const ipv4 = value => { const ip = String(value || '').replace(/^::ffff:/, '').replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, ''); return isIP(ip) === 4 ? ip : ''; };
const firstOctet = ip => Number(String(ip).split('.')[0]);
const isPublicDns = ip => PUBLIC_DNS.includes(ip) || PUBLIC_DNS_PREFIX.some(p => ip.startsWith(p));
const eightOf = ip => `${firstOctet(ip)}.0.0.0/8`;

// 这台电脑认定的公司自用 /8：网卡或 DNS 服务器落在企业名单里的段（排除公共 DNS），加上设置里明确写的 /8。
function companyEights({ dnsServers = [], nicIps = [], configured = [] } = {}) {
  const out = new Set();
  for (const raw of [...dnsServers, ...nicIps]) {
    const ip = ipv4(raw);
    if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.') || isPublicDns(ip)) continue;
    if (ENTERPRISE_EIGHTS.includes(firstOctet(ip))) out.add(eightOf(ip));
  }
  for (const c of configured) {
    const m = /^(\d{1,3})\.0\.0\.0\/8$/.exec(String(c || '').trim());
    if (m && Number(m[1]) <= 255) out.add(`${Number(m[1])}.0.0.0/8`);
  }
  return [...out];
}

// 在不在给定的公司 /8 里（或私网）。eights 不给时用整张企业名单（发送端用）。
function isIntranetIPv4(value, eights = ENTERPRISE_EIGHTS.map(n => `${n}.0.0.0/8`)) {
  const ip = ipv4(value);
  if (!ip) return false;
  if (isPrivateAddress(ip)) return true;
  if (isPublicDns(ip)) return false;
  return eights.some(c => c === eightOf(ip));
}

// 发送端接受的收件地址 IP：私网，或企业自用 /8 名单里的地址。
const acceptableIPv4 = value => isIntranetIPv4(value);

module.exports = { ENTERPRISE_EIGHTS, PUBLIC_DNS, isPublicDns, companyEights, isIntranetIPv4, acceptableIPv4 };
