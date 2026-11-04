import "./styles.css";

const buttons = document.querySelectorAll<HTMLButtonElement>("nav button");
const sections = document.querySelectorAll<HTMLElement>("main section");

buttons.forEach((button) => {
  button.addEventListener("click", () => {
    buttons.forEach((b) => b.classList.toggle("active", b === button));
    sections.forEach((s) => (s.hidden = s.id !== button.dataset.tab));
  });
});

// carousel arrows: rotate the card colors so the next one comes to the front
document.querySelectorAll<HTMLElement>(".carousel").forEach((carousel) => {
  const cards = [...carousel.querySelectorAll<HTMLElement>(".card")];
  const rotate = (step: number) => {
    const colors = cards.map((c) => getComputedStyle(c).backgroundColor);
    cards.forEach((c, i) => {
      c.style.backgroundColor = colors[(i + step + cards.length) % cards.length];
    });
  };
  carousel.querySelector(".prev")!.addEventListener("click", () => rotate(-1));
  carousel.querySelector(".next")!.addEventListener("click", () => rotate(1));
});

// shrink the header once the page scrolls
addEventListener("scroll", () => {
  document.body.classList.toggle("scrolled", scrollY > 0);
});
