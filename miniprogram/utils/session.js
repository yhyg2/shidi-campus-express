// 会话缓存：云开发下身份由 openid 决定，这里只缓存用户资料与当前校区。
const KEY = { user: 'sd_user', campus: 'sd_campus' };

const token = () => '';
const getUser = () => wx.getStorageSync(KEY.user) || null;
const setUser = user => { wx.setStorageSync(KEY.user, user || null); return user; };
const getCampus = () => wx.getStorageSync(KEY.campus) || '';
const setCampus = id => { wx.setStorageSync(KEY.campus, id); return id; };
const clear = () => { wx.removeStorageSync(KEY.user); wx.removeStorageSync(KEY.campus); };

module.exports = { token, getUser, setUser, getCampus, setCampus, clear };
