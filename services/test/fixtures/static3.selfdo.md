index.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Northline Studio — Home</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a class="logo" href="index.html">Northline Studio</a>
      <nav class="site-nav">
        <ul>
          <li><a href="index.html" class="active">Home</a></li>
          <li><a href="about.html">About</a></li>
          <li><a href="contact.html">Contact</a></li>
        </ul>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="container">
        <h1>Welcome to Northline Studio</h1>
        <p>Northline Studio is a small creative consultancy helping local businesses build clear, thoughtful brands. We believe good design should be simple, honest, and made to last.</p>
        <a class="button" href="contact.html">Get in touch</a>
      </div>
    </section>

    <section class="features">
      <div class="container features-grid">
        <article class="feature">
          <h2>Brand Identity</h2>
          <p>We craft logos, color systems, and visual guidelines that give your business a consistent, recognizable voice across every touchpoint.</p>
        </article>
        <article class="feature">
          <h2>Web Design</h2>
          <p>Clean, responsive websites designed around your customers — easy to navigate, quick to load, and straightforward to maintain.</p>
        </article>
        <article class="feature">
          <h2>Print &amp; Packaging</h2>
          <p>From business cards to product packaging, we design printed materials that look sharp and communicate clearly in the real world.</p>
        </article>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container">
      <p>&copy; 2026 Northline Studio. All rights reserved.</p>
    </div>
  </footer>
</body>
</html>
```

about.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Northline Studio — About</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a class="logo" href="index.html">Northline Studio</a>
      <nav class="site-nav">
        <ul>
          <li><a href="index.html">Home</a></li>
          <li><a href="about.html" class="active">About</a></li>
          <li><a href="contact.html">Contact</a></li>
        </ul>
      </nav>
    </div>
  </header>

  <main>
    <section class="page-intro">
      <div class="container">
        <h1>About Northline Studio</h1>
      </div>
    </section>

    <section class="container content">
      <p>Northline Studio is a small design and branding consultancy founded in 2014. We work with independent businesses, local shops, and growing teams who want their brand to feel as considered as the work they do. Our practice is intentionally compact: a few people, a focused set of services, and close collaboration with every client.</p>
      <p>Our approach starts with listening. Before we open a design file, we want to understand how your business works, who your customers are, and what you want your brand to say. From there, we develop clear, practical design solutions — identities, websites, and print materials — built to be used in the real world, not just admired in a portfolio.</p>
      <p>Whether you are launching something new or refining something familiar, we would be glad to hear about it. You can read more about our services on the home page, or reach us directly through the contact page.</p>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container">
      <p>&copy; 2026 Northline Studio. All rights reserved.</p>
    </div>
  </footer>
</body>
</html>
```

contact.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Northline Studio — Contact</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <a class="logo" href="index.html">Northline Studio</a>
      <nav class="site-nav">
        <ul>
          <li><a href="index.html">Home</a></li>
          <li><a href="about.html">About</a></li>
          <li><a href="contact.html" class="active">Contact</a></li>
        </ul>
      </nav>
    </div>
  </header>

  <main>
    <section class="page-intro">
      <div class="container">
        <h1>Contact Us</h1>
      </div>
    </section>

    <section class="container content contact-layout">
      <div class="contact-details">
        <h2>Get in touch</h2>
        <p>We usually reply within two business days. For project inquiries, a short note about your goals and timeline is helpful.</p>
        <ul class="details-list">
          <li><strong>Email:</strong> hello@example.com</li>
          <li><strong>Phone:</strong> +1 (555) 123-4567</li>
          <li><strong>Address:</strong> 123 Main Street, Suite 200, Springfield, USA</li>
        </ul>
      </div>

      <form action="#" class="contact-form">
        <label for="name">Name</label>
        <input type="text" id="name" name="name" placeholder="Your name" required>

        <label for="email">Email</label>
        <input type="email" id="email" name="email" placeholder="you@example.com" required>

        <label for="message">Message</label>
        <textarea id="message" name="message" rows="6" placeholder="How can we help?" required></textarea>

        <button type="submit" class="button">Send message</button>
      </form>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container">
      <p>&copy; 2026 Northline Studio. All rights reserved.</p>
    </div>
  </footer>
</body>
</html>
```

styles.css

```css
/* ===== Northline Studio — shared stylesheet ===== */

:root {
  --accent: #2f7d6f;        /* teal green */
  --accent-dark: #23604f;
  --text: #2b2b2b;
  --text-light: #6a6a6a;
  --bg: #fafaf8;
  --border: #e3e1dc;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  color: var(--text);
  background: var(--bg);
  line-height: 1.7;
}

h1, h2, h3 {
  font-family: "Helvetica Neue", Arial, sans-serif;
  line-height: 1.25;
  color: #1f1f1f;
}

h1 { font-size: 2.2rem; }
h2 { font-size: 1.4rem; margin-top: 0; }

p { margin: 0 0 1rem; }

a { color: var(--accent); }

.container {
  max-width: 960px;
  margin: 0 auto;
  padding: 0 1.25rem;
}

/* ===== Header ===== */
.site-header {
  background: #ffffff;
  border-bottom: 1px solid var(--border);
}

.header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  padding-top: 1rem;
  padding-bottom: 1rem;
}

.logo {
  font-family: "Helvetica Neue", Arial, sans-serif;
  font-weight: bold;
  font-size: 1.15rem;
  text-decoration: none;
  color: var(--accent);
}

.site-nav ul {
  list-style: none;
  display: flex;
  gap: 1.25rem;
  margin: 0;
  padding: 0;
}

.site-nav a {
  text-decoration: none;
  font-family: "Helvetica Neue", Arial, sans-serif;
  font-size: 0.95rem;
  color: var(--text);
  padding: 0.25rem 0;
}

.site-nav a:hover,
.site-nav a.active {
  color: var(--accent);
  border-bottom: 2px solid var(--accent);
}

/* ===== Hero ===== */
.hero {
  background: linear-gradient(135deg, var(--accent), var(--accent-dark));
  color: #ffffff;
  padding: 4rem 0;
}

.hero h1 {
  color: #ffffff;
  margin-top: 0;
}

.hero p {
  max-width: 40rem;
  font-size: 1.05rem;
}

.hero .button {
  margin-top: 0.5rem;
}

/* ===== Buttons ===== */
.button {
  display: inline-block;
  background: #ffffff;
  color: var(--accent-dark);
  font-family: "Helvetica Neue", Arial, sans-serif;
  font-weight: bold;
  font-size: 0.95rem;
  padding: 0.65rem 1.5rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.2s ease;
}

.button:hover { background: #e9f4f1; }

/* ===== Features ===== */
.features { padding: 3rem 0; }

.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.5rem;
}

.feature {
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1.5rem;
}

.feature h2 { color: var(--accent-dark); }

/* ===== Page intro ===== */
.page-intro {
  background: #ffffff;
  border-bottom: 1px solid var(--border);
  padding: 2.5rem 0;
  margin-bottom: 2rem;
}

.page-intro h1 { margin: 0; }

.content { padding-bottom: 3rem; }

/* ===== Contact ===== */
.contact-layout {
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  gap: 2.5rem;
}

.details-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.details-list li {
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
}

.contact-form label {
  display: block;
  font-family: "Helvetica Neue", Arial, sans-serif;
  font-size: 0.85rem;
  font-weight: bold;
  margin: 1rem 0 0.35rem;
}

.contact-form input,
.contact-form textarea {
  width: 100%;
  padding: 0.6rem 0.75rem;
  font: inherit;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: #ffffff;
}

.contact-form input:focus,
.contact-form textarea:focus {
  outline: 2px solid var(--accent);
  border-color: var(--accent);
}

.contact-form .button {
  margin-top: 1.25rem;
  background: var(--accent);
  color: #ffffff;
}

.contact-form .button:hover { background: var(--accent-dark); }

/* ===== Footer ===== */
.site-footer {
  border-top: 1px solid var(--border);
  background: #ffffff;
  padding: 1.25rem 0;
  text-align: center;
  color: var(--text-light);
  font-size: 0.9rem;
}

/* ===== Responsive ===== */
@media (max-width: 720px) {
  .features-grid { grid-template-columns: 1fr; }
  .contact-layout { grid-template-columns: 1fr; gap: 1.5rem; }
  .header-inner { justify-content: center; }
}
```

All four files are complete and ready to save in the same folder. Each page links the shared `styles.css`, uses the same header/nav/footer, and the layout collapses to a single column on small screens — no JavaScript or external dependencies.