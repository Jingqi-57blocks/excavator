(function () {
  const content = document.querySelector('.content');
  const toc = document.getElementById('toc');
  const slug = (text) => text.trim().toLowerCase()
    .replace(/[\s\/]+/g, '-')
    .replace(/[^\w\-]/g, '')
    .replace(/-+/g, '-');

  if (content && toc) {
    const headings = [...content.querySelectorAll('h2')];
    headings.forEach((h, i) => {
      if (!h.id) h.id = slug(h.textContent) || `section-${i + 1}`;
      const a = document.createElement('a');
      a.href = `#${h.id}`;
      a.textContent = h.textContent.trim();
      a.className = 'level-2';
      toc.appendChild(a);
    });
    if ('IntersectionObserver' in window) {
      const links = new Map([...toc.querySelectorAll('a')].map(a => [decodeURIComponent(a.hash.slice(1)), a]));
      const io = new IntersectionObserver((entries) => {
        const visible = entries.filter(e => e.isIntersecting).sort((a,b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        toc.querySelectorAll('a').forEach(a => a.classList.remove('current'));
        const a = links.get(visible.target.id);
        if (a) a.classList.add('current');
      }, { rootMargin: '-90px 0px -72% 0px', threshold: [0,1] });
      headings.forEach(h => io.observe(h));
    }
  }

  const top = document.querySelector('.back-to-top');
  if (top) {
    const sync = () => top.classList.toggle('visible', window.scrollY > 700);
    window.addEventListener('scroll', sync, { passive: true }); sync();
    top.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  const dialog = document.getElementById('diagramDialog');
  const dialogBody = dialog?.querySelector('.dialog-body');
  document.querySelectorAll('.diagram-expand').forEach(btn => {
    btn.addEventListener('click', () => {
      const diagram = btn.closest('.diagram');
      const svg = diagram?.querySelector('.mermaid svg');
      if (!dialog || !dialogBody || !svg) return;
      dialogBody.innerHTML = '';
      dialogBody.appendChild(svg.cloneNode(true));
      dialog.showModal();
    });
  });
  dialog?.querySelector('.dialog-close')?.addEventListener('click', () => dialog.close());
  dialog?.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  const status = document.querySelector('.diagram-status');
  if (window.mermaid) {
    try {
      mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'loose',
        themeVariables: { fontFamily: 'Inter, system-ui, sans-serif', primaryColor: '#eff6ff', primaryTextColor: '#172033', primaryBorderColor: '#93c5fd', lineColor: '#64748b', secondaryColor: '#f8fafc', tertiaryColor: '#ecfdf5' },
        flowchart: { curve: 'basis', htmlLabels: true }, state: { useMaxWidth: true }
      });
      mermaid.run({ querySelector: '.mermaid' }).catch(() => { if (status) status.style.display = 'block'; });
    } catch (_) { if (status) status.style.display = 'block'; }
  } else if (document.querySelector('.mermaid') && status) status.style.display = 'block';
})();