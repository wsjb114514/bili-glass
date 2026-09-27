const { app } = require('electron');
app.whenReady().then(() => {
  const st = app.getGPUFeatureStatus();
  console.log('GPU feature status:', JSON.stringify(st));
  console.log('GPU info:', JSON.stringify(require('electron').app.getGPUInfo ? 'n/a' : ''));
  const info = app.getGPUInfo('basic');
  info.then((i) => { console.log(JSON.stringify(i).slice(0, 600)); app.quit(); }).catch((e)=>{console.log('err', e.message); app.quit();});
});
