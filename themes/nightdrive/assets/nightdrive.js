// Nightdrive: arrivals, the menu (Escape closes it), and buttons that lean toward the pointer.
// Every page reads fully without it.
(function () {
  // Tell the failsafe in <head> the reveal is running; without this, it shows everything.
  window.__arrived = true
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  var calm = false

  var items = document.querySelectorAll('.reveal')
  if (!('IntersectionObserver' in window) || reduced) {
    items.forEach(function (el) { el.classList.add('is-in') })
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return
        e.target.classList.add('is-in')
        io.unobserve(e.target)
      })
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 })
    items.forEach(function (el) { io.observe(el) })
  }

  if (reduced || calm || !matchMedia('(pointer: fine)').matches) return
  document.querySelectorAll('.magnetic').forEach(function (el) {
    var frame = 0
    el.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect()
      var x = (e.clientX - r.left - r.width / 2) * 0.22
      var y = (e.clientY - r.top - r.height / 2) * 0.3
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(function () {
        el.style.transition = 'transform 0.2s cubic-bezier(0.32, 0.72, 0, 1)'
        el.style.transform = 'translate(' + x + 'px,' + y + 'px)'
      })
    })
    el.addEventListener('pointerleave', function () {
      cancelAnimationFrame(frame)
      el.style.transition = 'transform 0.7s cubic-bezier(0.22, 1.2, 0.36, 1)'
      el.style.transform = ''
    })
  })
})()

// The menu is a <details>: it opens and closes with no script at all. This
// only adds Escape, and closes it when a link inside is followed.
;(function () {
  var menu = document.querySelector('.menu')
  if (!menu) return
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menu.open) {
      menu.open = false
      menu.querySelector('summary').focus()
    }
  })
  menu.addEventListener('click', function (e) {
    if (e.target.closest('a')) menu.open = false
  })
})()
