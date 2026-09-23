// Folio's only script: reveal things as they arrive. Content is fully visible
// without it; the `.js` class set in <head> is what opts into hiding.
(function () {
  // Tell the failsafe in <head> the reveal is running; without this, it shows everything.
  window.__arrived = true
  var items = document.querySelectorAll('.reveal')
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    items.forEach(function (el) { el.classList.add('is-in') })
    return
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return
      e.target.classList.add('is-in')
      io.unobserve(e.target)
    })
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 })
  items.forEach(function (el) { io.observe(el) })
})()
