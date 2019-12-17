const path = require('path')
const consola = require('consola')

module.exports = {
	// 基础目录，绝对路径，用于从配置中解析入口起点和loader，默认使用当前目录，也就是默认在哪里执行node命令的位置
	context: __dirname,

	target: 'web', // 默认是web

	mode: 'development',

	// 监听文件变动，实时进行打包
	// watch: true,

	// 对watch的配置，参考文档
	// watchOptions: {}

	// 起点或是应用程序的起点入口。从这个起点开始，应用程序启动执行。如果传递一个数组，那么数组的每一项都会执行。
    entry: {
		customOutputFile: './src/index.js'
	},

    output: {
        path: path.join(__dirname, './dist'),
	},

    module: {
        rules: [
            {
                test: /\.js$/,
                use: [
					// 'babel-loader',
					{
						loader: path.resolve(__dirname,'./loader.js')
					}
				],
                exclude: /node_modules/,
			}
        ]
	},

	optimization: {
		// minimize: true
	},

	plugins: [
		// plugin的第一种写法，是个对象，对象拥有apply方法，接收的参数是compiler实例
		(compiler) => {
			compiler.hooks.afterEmit.tap('runCallback', () => {
				console.log(' 自定义插件B：我勾住了afterEmit钩子')
			})
			console.log(' 这里是个自定义插件B～')
		},

		// plugin的第二种写法，直接是个函数，接收的参数是compiler实例
		{
			apply: (compiler) => {
				compiler.hooks.run.tap('runCallback', () => {
					console.log(' 自定义插件A：我勾住了run钩子')
				})
				console.log(' 这里是个自定义插件A～')
			}
		}
	],

	// devtool: 'source-map',
	devtool: false
}
