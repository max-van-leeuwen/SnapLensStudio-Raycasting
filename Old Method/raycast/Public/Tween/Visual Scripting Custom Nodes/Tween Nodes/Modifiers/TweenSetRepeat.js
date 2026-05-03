// @input tweenObj tweenIn
// @input int numTimes = -1
// @input bool infinite
// @output tweenObj tweenOut

script.tweenOut = script.tweenIn.repeat(script.infinite ? "Infinity" : script.numTimes);