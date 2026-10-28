'use strict';
const profiles = require('../../core/antigravity-subscription-profiles');
const {createAntigravityUsage} = require('./antigravity-account-usage');

// Each reader owns its native credential environment, cached result and flight.
function createAntigravityProfilesUsage({getConfig,env=process.env,createReader=createAntigravityUsage}={}) {
  const readers=new Map(), values=new Map(), selections=new Map();
  const list=()=>profiles.normalizeProfiles(getConfig().antigravitySubscriptionProfiles,
    env.CLAUDE_HUB_HOME_DIR || env.USERPROFILE || env.HOME);
  function resolve(id) {
    const profile=profiles.resolveProfile(getConfig(),id,env);
    return {profile,scope:profiles.publicAuthInfo(profile).authScope};
  }
  function scope(id) {const selected=resolve(id);selections.set(selected.scope,selected.profile.id);return selected.scope;}
  async function refresh(key,force=false) {
    if(!selections.has(key)) throw new Error('Antigravity 账号归属尚未确认，请刷新账号额度');
    const selected=resolve(selections.get(key));
    if(selected.scope!==key) throw new Error('Antigravity 登录已变化，请刷新账号额度');
    let reader=readers.get(key);
    if(!reader) {
      reader=createReader({env:profiles.applyProfileEnv(env,selected.profile)});
      readers.set(key,reader);
    }
    const value=await reader.refresh(force);
    if(scope(selected.profile.id)!==key) throw new Error('Antigravity 登录已变化，本次额度结果未采用');
    values.set(key,value);
    return value;
  }
  return {profiles:list,scope,refresh,cached:key=>values.get(key)||null};
}
module.exports={createAntigravityProfilesUsage};
