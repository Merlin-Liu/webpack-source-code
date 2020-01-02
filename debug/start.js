const consola = require('consola')

const webpack = require('../lib/index.js')  // 直接使用源码中的webpack函数
const config = require('./webpack.config')

console.log('webpack任务开始执行～')

// 如果传入回调函数会自动执行compiler的run方法进行编译
webpack(config, (err, stats) => {
	if (err) {
		return consola.fatal(err)
	}

	console.log('webpack任务执行完成～')
})

// 下面是手动执行run方法
const compiler = webpack(config)
compiler.run((err, stats) => {
	if (err) {
		return consola.fatal(err)
	}

 consola.success('webpack任务执行完成～')
})

// webpack中存在非常重要的两个核心对象compiler、compilation
// compiler代表的是不变的webpack环境
// compilation代表的是一次编译作业，每一次的编译都可能不同
// compiler就像一条流水线，而compilation代表的是产出的东西，可能会不同
