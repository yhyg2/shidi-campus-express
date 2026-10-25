// 校区列表的展示层拼装：多页面共用，避免 home / create 各写一份。
function options(campuses, currentId) {
  return (campuses || []).map(campus => {
    return {
      id: campus.id,
      name: campus.name,
      active: campus.id === currentId,
      meta: (campus.stations ? campus.stations.length : 0) + ' 个驿站' + (campus.buildings && campus.buildings.length ? ' · ' + campus.buildings.length + ' 个楼栋' : '')
    };
  });
}

function label(campuses, currentId) {
  const campus = (campuses || []).find(item => item.id === currentId);
  return campus ? campus.name : '选择校区';
}

module.exports = { options, label };
