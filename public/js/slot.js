// 3D Slot Machine Reels Controller
class SlotMachine {
  constructor() {
    this.reels = [
      { id: 'reel-0', section: 'genres', element: null, strip: null, isHeld: false },
      { id: 'reel-1', section: 'categories', element: null, strip: null, isHeld: false },
      { id: 'reel-2', section: 'miscellaneous', element: null, strip: null, isHeld: false }
    ];
    this.isSpinning = false;
    this.prompts = null;
    this.itemHeight = 140; // Default item height in px, dynamically measured
  }

  init(prompts) {
    this.prompts = prompts;
    this.reels.forEach((reel, index) => {
      reel.element = document.getElementById(`reel-${index}`);
      if (reel.element) {
        reel.strip = reel.element.querySelector('.reel-strip');
        this.populateStrip(index, this.getListForIndex(index));
      }
    });

    // Recalculate item height on resize
    this.measureHeight();
    window.addEventListener('resize', () => this.measureHeight());
  }

  measureHeight() {
    const firstItem = document.querySelector('.reel-item');
    const fallback = window.innerWidth <= 768 ? 92 : 140;
    if (firstItem) {
      this.itemHeight = firstItem.offsetHeight || fallback;
    } else {
      this.itemHeight = fallback;
    }
  }

  getListForIndex(index) {
    if (!this.prompts) return [];
    if (index === 0) return this.prompts.genres || [];
    if (index === 1) return this.prompts.categories || [];
    return this.prompts.miscellaneous || [];
  }

  // Populate strip with items repeated to create a seamless scrolling loop
  populateStrip(reelIndex, list, targetItem = null) {
    const strip = this.reels[reelIndex].strip;
    if (!strip || !list || list.length === 0) return;

    // Create a long strip: 4 repeated sets + target at top
    let html = '';
    const itemsToRender = [];

    // If target provided, place it at the resting position (first item)
    if (targetItem) {
      itemsToRender.push(targetItem);
    }

    // Repeat pool to make it visually full
    for (let r = 0; r < 5; r++) {
      itemsToRender.push(...list);
    }

    itemsToRender.forEach((item) => {
      html += `
        <div class="reel-item" data-id="${item.id}" style="--accent-color: ${item.color || '#ff007f'}">
          <div class="item-icon">${item.icon || '🎵'}</div>
          <div class="item-details">
            <span class="item-title">${item.name}</span>
            <small class="item-hint">${item.hint || ''}</small>
          </div>
        </div>
      `;
    });

    strip.innerHTML = html;
  }

  // Set initial resting items
  setReelItems(targets) {
    if (!targets) return;
    targets.forEach((target, index) => {
      if (target && this.reels[index].strip) {
        this.populateStrip(index, this.getListForIndex(index), target);
        this.reels[index].strip.style.transform = 'translateY(0px)';
      }
    });
  }

  // Set held states
  setHeldStates(heldArray) {
    if (!heldArray) return;
    heldArray.forEach((isHeld, index) => {
      this.reels[index].isHeld = isHeld;
      const holdBtn = document.getElementById(`hold-btn-${index}`);
      const reelEl = document.getElementById(`reel-${index}`);
      if (holdBtn) {
        holdBtn.classList.toggle('active', isHeld);
        holdBtn.setAttribute('aria-pressed', isHeld ? 'true' : 'false');
      }
      if (reelEl) {
        reelEl.classList.toggle('held', isHeld);
      }
    });
  }

  // Perform synchronized animated spin
  spinTo(targets, held = [false, false, false], durations = [2200, 3000, 3800], onAllStopped = null) {
    if (this.isSpinning) return;
    this.isSpinning = true;

    this.measureHeight();
    const itemH = this.itemHeight;

    // Animate lever pull
    const lever = document.querySelector('.jackpot-lever');
    if (lever) {
      lever.classList.add('pulled');
      setTimeout(() => lever.classList.remove('pulled'), 600);
    }

    if (window.soundManager) {
      window.soundManager.playLever();
    }

    let stoppedCount = 0;

    this.reels.forEach((reel, index) => {
      const isReelHeld = held[index];
      const target = targets[index];
      const duration = durations[index] || (2000 + index * 800);
      const strip = reel.strip;
      const reelEl = reel.element;

      if (isReelHeld) {
        stoppedCount++;
        if (stoppedCount === 3 && onAllStopped) {
          this.isSpinning = false;
          onAllStopped();
        }
        return;
      }

      if (!strip) return;

      // Prepare strip with target item placed ahead
      const list = this.getListForIndex(index);
      this.populateStrip(reelIndex(index), list, target);

      reelEl.classList.add('blur-spin');

      // Ticking interval
      const tickInterval = setInterval(() => {
        if (window.soundManager) {
          window.soundManager.playTick(500 + index * 100);
        }
      }, 90);

      // Fast CSS spin animation
      const spins = 16 + index * 6; // Number of items to fly through
      const targetOffset = -spins * itemH;

      strip.style.transition = `transform ${duration}ms cubic-bezier(0.12, 0.8, 0.25, 1)`;
      strip.style.transform = `translateY(${targetOffset}px)`;

      setTimeout(() => {
        clearInterval(tickInterval);
        reelEl.classList.remove('blur-spin');

        // Snap neatly to target
        this.populateStrip(index, list, target);
        strip.style.transition = 'none';
        strip.style.transform = 'translateY(0px)';

        // Add bounce impact
        reelEl.classList.add('reel-bounce');
        setTimeout(() => reelEl.classList.remove('reel-bounce'), 400);

        if (window.soundManager) {
          window.soundManager.playReelStop(index);
        }

        stoppedCount++;
        if (stoppedCount === 3) {
          this.isSpinning = false;
          if (window.soundManager) {
            window.soundManager.playJackpotFanfare();
          }
          if (window.confetti) {
            window.confetti.burst(100);
          }
          if (onAllStopped) onAllStopped();
        }
      }, duration);
    });
  }
}

function reelIndex(idx) {
  return idx;
}

window.slotMachine = new SlotMachine();
