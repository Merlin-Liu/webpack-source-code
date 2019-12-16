const { SyncHook, AsyncSeriesBailHook, AsyncSeriesHook } = require("tapable");
// let sh = new SyncHook(["name"])
// sh.tap('A', (name) => {
//     console.log('A:', name)
// })
// sh.tap({
//     name: 'B',
//     before: 'A'  // 影响该回调的执行顺序, 回调B比回调A先执行
// }, (name) => {
//     console.log('B:', name)
// })
// sh.call('Tapable')

// output:
// B:Tapable
// A:Tapable

// const asyncTapable = new AsyncSeriesBailHook(['lgf'])
// asyncTapable.tapAsync('lgf', (r, c) => {
// 	console.log(r)
// 	c()
// })
// asyncTapable.callAsync({a: 1}, () => {
// 	console.log(1111)
// })

let queue2 = new AsyncSeriesHook(['name']);
// console.time('cost2');
// queue2.tapAsync('1', function (name, cb) {
//     setTimeout(() => {
//         console.log(name, 1);
//         cb();
//     }, 1000);
// });
// queue2.tapAsync('2', function (name, cb) {
//     setTimeout(() => {
//         console.log(name, 2);
//         cb();
//     }, 2000);
// });
// queue2.tapAsync('3', function (name, cb) {
//     setTimeout(() => {
//         console.log(name, 3);
//         cb();
//     }, 3000);
// });

queue2.callAsync('webpack', (err) => {
    console.log(err);
	console.log('over');
    // console.timeEnd('cost2');
});
// 执行结果
/*
webpack 1
webpack 2
webpack 3
undefined
over
cost2: 6019.621ms
*/
