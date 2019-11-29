const webpack = require('../lib/index.js')  // 直接使用源码中的webpack函数
const config = require('./webpack.config')
const compiler = webpack(config, () => {
	console.log('webpack执行完成')
})
// compiler.run((err, stats) => {
// 	if (err) {
// 		console.error(err)
// 	}
// 	else {
// 		console.error('success')
// 	}
// })

// webpack中存在非常重要的两个核心对象compiler、compilation
// compiler代表的是不变的webpack环境
// compilation代表的是一次编译作业，每一次的编译都可能不同
// compiler就像一条流水线，而compilation代表的是产出的东西，可能会不同
