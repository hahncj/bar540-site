// <stir-loader label="Reading the label…"></stir-loader>  (add size="large" for a page-level wait)
// A mixing glass being stirred with a bar spoon, shown while the site waits on the server.
// Self-contained: the styles are added once, the first time this file loads.
(function(){
  if (window.customElements.get('stir-loader')) return;

  var style = document.createElement('style');
  style.textContent =
    'stir-loader{display:inline-flex; align-items:center; gap:10px; vertical-align:middle;}' +
    'stir-loader svg{width:34px; height:46px; flex:none; overflow:visible;}' +
    'stir-loader[size="large"] svg{width:54px; height:73px;}' +
    '.stir-label{font-size:14px; color:var(--cream-dim, #aab0c2);}' +
    '.stir-spoon{transform-box:view-box; transform-origin:26px -6px; animation:stir-spoon 1.1s ease-in-out infinite alternate;}' +
    '.stir-ice-a{transform-box:view-box; animation:stir-ice 1.1s ease-in-out infinite alternate;}' +
    '.stir-ice-b{transform-box:view-box; animation:stir-ice 1.1s ease-in-out infinite alternate-reverse;}' +
    '.stir-surface{transform-box:view-box; transform-origin:24px 27px; animation:stir-surface 1.1s ease-in-out infinite alternate;}' +
    '@keyframes stir-spoon{from{transform:rotate(-9deg);} to{transform:rotate(9deg);}}' +
    '@keyframes stir-ice{from{transform:translate(-3px, 1px) rotate(-12deg);} to{transform:translate(4px, -1px) rotate(14deg);}}' +
    '@keyframes stir-surface{from{transform:rotate(-3deg) scaleX(0.96);} to{transform:rotate(3deg) scaleX(1.02);}}' +
    '@media (prefers-reduced-motion: reduce){.stir-spoon, .stir-ice-a, .stir-ice-b, .stir-surface{animation:none;}}';
  document.head.appendChild(style);

  var GLASS = 'M8 6L40 6L37 58Q37 61 34 61L14 61Q11 61 11 58Z';
  var count = 0;
  // Each loader gets its own clip/gradient ids, so removing one never breaks another still on the page.
  function svg(n){ return (
    '<svg viewBox="0 -9 48 72" aria-hidden="true">' +
      '<defs>' +
        '<clipPath id="stirGlass"><path d="' + GLASS + '"/></clipPath>' +
        '<linearGradient id="stirLiquid" x1="0" x2="0" y1="0" y2="1">' +
          '<stop offset="0" stop-color="#f0a83a"/><stop offset="1" stop-color="#a8581a"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<path d="' + GLASS + '" fill="rgba(255,255,255,0.07)"/>' +
      '<g clip-path="url(#stirGlass)">' +
        '<rect x="0" y="27" width="48" height="40" fill="url(#stirLiquid)"/>' +
        '<ellipse class="stir-surface" cx="24" cy="27" rx="17" ry="2.2" fill="#f7c26a"/>' +
        '<rect class="stir-ice-a" x="14" y="31" width="9" height="9" rx="2" fill="rgba(255,255,255,0.5)" stroke="rgba(255,255,255,0.8)" stroke-width="0.8"/>' +
        '<rect class="stir-ice-b" x="25" y="41" width="8" height="8" rx="2" fill="rgba(255,255,255,0.45)" stroke="rgba(255,255,255,0.75)" stroke-width="0.8"/>' +
      '</g>' +
      // Bar spoon: twisted shaft, small bowl at the bottom, disc at the top.
      '<g class="stir-spoon">' +
        '<line x1="26" y1="-6" x2="24" y2="50" stroke="#d6dde3" stroke-width="1.8" stroke-linecap="round"/>' +
        '<line x1="25.6" y1="2" x2="24.4" y2="44" stroke="#8e979f" stroke-width="1.8" stroke-dasharray="1.4 1.6"/>' +
        '<ellipse cx="24" cy="51" rx="2.4" ry="3.4" fill="#d6dde3"/>' +
        '<circle cx="26" cy="-7" r="2" fill="#d6dde3"/>' +
      '</g>' +
      '<path d="' + GLASS + '" fill="none" stroke="rgba(245,239,228,0.6)" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="M13 10L15 54" stroke="rgba(255,255,255,0.25)" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>').replace(/stirGlass|stirLiquid/g, function(id){ return id + n; });
  }

  window.customElements.define('stir-loader', class extends HTMLElement {
    static get observedAttributes(){ return ['label']; }
    connectedCallback(){
      if (this.querySelector('svg')) return;
      this.setAttribute('role', 'status');
      this.innerHTML = svg(++count) + '<span class="stir-label"></span>';
      this.attributeChangedCallback();
    }
    attributeChangedCallback(){
      var label = this.querySelector('.stir-label');
      if (label) label.textContent = this.getAttribute('label') || 'Mixing…';
    }
  });

  // Helper for status lines: swap their text for the stirring glass while something is in flight.
  window.showStir = function(el, label){
    var loader = document.createElement('stir-loader');
    loader.setAttribute('label', label);
    el.textContent = '';
    el.appendChild(loader);
  };
})();
