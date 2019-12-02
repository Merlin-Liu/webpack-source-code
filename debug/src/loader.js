module.exports = function (s) {
	console.log('custom loader~~')
	console.log(s)
	console.log('custom loader~~')
	return `let c = 2; const b = 3;`
}
