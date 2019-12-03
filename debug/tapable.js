const { SyncHook } = require("tapable");
let sh = new SyncHook(["name"])
sh.tap('A', (name) => {
    console.log('A:', name)
})
sh.tap({
    name: 'B',
    before: 'A'  // 影响该回调的执行顺序, 回调B比回调A先执行
}, (name) => {
    console.log('B:', name)
})
sh.call('Tapable')

// output:
// B:Tapable
// A:Tapable
