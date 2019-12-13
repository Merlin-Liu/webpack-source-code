import consola from 'consola'
import is from 'object.is'  // 这里引入一个小而美的第三方库，以此观察webpack如何处理第三方包
// import throttle from 'lodash.throttle'

// const fn = throttle(() => {
// 	console.error('11212212')
// }, 3000)

consola.success('i am webpack~~～～～')
consola.info(is(1,1))
