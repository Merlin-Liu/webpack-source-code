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
					'babel-loader',
					{
						loader: path.resolve(__dirname,'./src/loader.js')
					}
				],
                exclude: /node_modules/,
			}
        ]
	},

	plugins: [
		// plugin的第一种写法，直接是个函数，接收的参数是compiler实例
		{
			apply: (compiler) => {
				compiler.hooks.run.tap('runCallback', () => {
					consola.info(' 我勾住了run方法')
				})
				consola.info(' 这里是个自定义插件A～')
			}
		},

		// plugin的第二种写法，是个对象，对象拥有apply方法，接收的参数是compiler实例
		(compiler) => {
			compiler.hooks.afterEmit.tap('runCallback', () => {
				consola.info(' 我勾住了afterEmit方法')
			})
			consola.info(' 这里是个自定义插件B～')
		}
	],

	// devtool: 'source-map',
	devtool: false
}
