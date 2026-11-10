import { Footer } from '@/components/landing/Footer';
import { Hero } from '@/components/landing/Hero';
import { Navbar } from '@/components/Navbar';
import { SmoothScroll } from '@/components/SmoothScroll';

export default function Page() {
  return (
    <>
      <SmoothScroll />
      <Navbar />
      <main>
        <Hero />
      </main>
      <Footer />
    </>
  );
}
