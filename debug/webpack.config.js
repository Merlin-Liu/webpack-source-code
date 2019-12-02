const path = require('path')

module.exports = {
    context: __dirname,
    mode: 'development',
    // devtool: 'source-map',
    entry: {
		sb: './src/index.js'
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
						loader: path.resolve('./src/loader.js')
					}
				],
                exclude: /node_modules/,
			}
        ]
	},

	plugins: [
		{
			apply: () => {
				console.log('I am a custcom plugin~')
			}
		}
	],

	devtool: false
}
