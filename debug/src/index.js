const  consola = require('consola')
import is from 'object.is'  // 这里引入一个小而美的第三方库，以此观察webpack如何处理第三方包
consola.success('很高兴认识你，webpack132311')
consola.info(is(1,1))
