// @input tweenObj tweenIn
// @input float toValue
// @input float time

// @output tweenObj tweenOut

script.tweenOut = script.tweenIn.to({t:script.toValue}, script.time * 1000);