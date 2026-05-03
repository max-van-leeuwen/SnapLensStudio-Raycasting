// @input tweenObj tweenIn
// @input function float(float t) easingFunc
// @output tweenObj tweenOut

script.tweenOut = script.easingFunc
    ? script.tweenIn.easing(script.easingFunc)
    : script.tweenIn;