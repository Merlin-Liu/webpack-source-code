const path = require('path')

module.exports = {
    context: __dirname,
    mode: 'development',
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
		{
			apply: () => {
				console.log('I am a custcom plugin ~')
			}
		}
	],

	// devtool: 'source-map',
	devtool: false
}
