$(document).ready(function () {
  // ========== GLOBALS ==========
  let currentCategory = 'All';
  let cart = JSON.parse(localStorage.getItem('gearbari_cart') || '[]');
  let isAdmin = false;
  let currentUser = null;
  let token = localStorage.getItem('token') || null;
  const LOW_STOCK_THRESHOLD = 5;
  // Tracks which product ids are currently rendered on the storefront grid,
  // so the live-stock poller only asks the server about visible products.
  let visibleProductIds = [];
  let stockPollTimer = null;
  let adminPollTimer = null;

  // ========== DOM REFS ==========
  const $grid = $('#product-grid');
  const $cartBadge = $('#cart-badge');
  const $cartItemsList = $('#cart-items-list');
  const $cartTotal = $('#cart-total-amount');
  const $orderSubtotal = $('#order-subtotal');
  const $orderDelivery = $('#order-delivery');
  const $orderDeliveryCharge = $('#order-delivery-charge');
  const $orderTotal = $('#order-total');

  // ========== 1. LOAD PRODUCTS ==========

  // Returns the little "In Stock: N items" line shown on every product card,
  // plus whether ordering controls should be disabled for 0 stock.
  function stockInfoHtml(stock) {
    if (stock <= 0) {
      return { html: '<span class="stock-line stock-out"><i class="bi bi-x-circle"></i> Out of Stock</span>', disabled: true };
    }
    if (stock <= LOW_STOCK_THRESHOLD) {
      return { html: `<span class="stock-line stock-low"><i class="bi bi-exclamation-triangle"></i> In Stock: ${stock} item${stock === 1 ? '' : 's'} (low)</span>`, disabled: false };
    }
    return { html: `<span class="stock-line stock-ok"><i class="bi bi-check-circle"></i> In Stock: ${stock} items</span>`, disabled: false };
  }

  function loadProducts(category = 'All', search = '') {
    let url = `/api/products?category=${encodeURIComponent(category)}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;

    $.ajax({
      url: url,
      method: 'GET',
      success: function (products) {
        $grid.empty();
        visibleProductIds = products.map(p => p._id);
        if (products.length === 0) {
          $grid.html('<div class="col-12 text-center text-muted py-5">No products found yet. Ask an admin to add products from the dashboard.</div>');
          return;
        }
        products.forEach(function (item) {
          let badgeHtml = item.badge ? `<span class="badge gb-badge position-absolute top-0 start-0 m-3">${item.badge}</span>` : '';
          const stockInfo = stockInfoHtml(item.stock);
          const disabledAttr = stockInfo.disabled ? 'disabled' : '';
          const cardHtml = `
            <div class="col-6 col-md-4 col-lg-3">
              <div class="gb-card h-100 position-relative ${stockInfo.disabled ? 'card-out-of-stock' : ''}" data-product-id="${item._id}">
                ${badgeHtml}
                <img src="${item.image}" class="card-img-top rounded" alt="${item.name}" style="height: 180px; object-fit: cover;">
                <div class="card-body d-flex flex-column p-2">
                  <span class="text-uppercase text-muted" style="font-size: 0.75rem;">${item.category}</span>
                  <h6 class="card-title text-white fw-semibold mt-1">${item.name}</h6>
                  <div class="mt-auto">
                    <div class="d-flex justify-content-between align-items-center">
                      <span class="gb-price">${item.price.toLocaleString()}</span>
                    </div>
                    <div class="stock-wrap mt-1" data-stock-wrap="${item._id}" data-stock="${item.stock}">
                      ${stockInfo.html}
                    </div>
                    <div class="d-flex align-items-center gap-2 mt-2">
                      <div class="input-group input-group-sm" style="width: 90px;">
                        <button class="btn btn-outline-secondary btn-sm qty-minus" data-id="${item._id}" ${disabledAttr}>-</button>
                        <input type="text" class="form-control form-control-sm text-center bg-dark text-white border-secondary qty-input" value="1" data-id="${item._id}" data-max="${item.stock}" style="width: 30px;" ${disabledAttr}>
                        <button class="btn btn-outline-secondary btn-sm qty-plus" data-id="${item._id}" ${disabledAttr}>+</button>
                      </div>
                      <button class="btn btn-sm btn-warning add-cart-btn" data-id="${item._id}" data-name="${item.name}" data-price="${item.price}" data-image="${item.image}" ${disabledAttr}>
                        <i class="bi bi-cart-plus"></i>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>`;
          $grid.append(cardHtml);
        });
      },
      error: function (err) {
        console.error('Error fetching products:', err);
      }
    });
  }

  // ========== LIVE STOCK POLLING ==========
  // Keeps the "In Stock: N items" line (and the customer's admin Stock tab)
  // accurate without a full page refresh: if someone else buys the last unit,
  // or the admin edits stock in the dashboard, everyone watching the page
  // sees it update within a few seconds.
  function refreshVisibleStock() {
    if (!visibleProductIds || visibleProductIds.length === 0) return;
    $.ajax({
      url: `/api/products/stock?ids=${visibleProductIds.join(',')}`,
      method: 'GET',
      success: function (rows) {
        rows.forEach(row => {
          applyStockToCard(row._id, row.stock);
        });
      },
      error: function () { /* silent - just try again next tick */ }
    });
  }

  function applyStockToCard(productId, stock) {
    const $wrap = $(`[data-stock-wrap="${productId}"]`);
    if ($wrap.length === 0) return;
    const previousStock = parseInt($wrap.attr('data-stock'), 10);
    if (previousStock === stock) return; // nothing changed, don't touch the DOM

    $wrap.attr('data-stock', stock);
    const info = stockInfoHtml(stock);
    $wrap.html(info.html);

    const $card = $(`.gb-card[data-product-id="${productId}"]`);
    const $qtyInput = $(`.qty-input[data-id="${productId}"]`);
    const $qtyMinus = $(`.qty-minus[data-id="${productId}"]`);
    const $qtyPlus = $(`.qty-plus[data-id="${productId}"]`);
    const $addBtn = $(`.add-cart-btn[data-id="${productId}"]`);

    $qtyInput.attr('data-max', stock);
    $card.toggleClass('card-out-of-stock', info.disabled);
    $qtyInput.prop('disabled', info.disabled);
    $qtyMinus.prop('disabled', info.disabled);
    $qtyPlus.prop('disabled', info.disabled);
    $addBtn.prop('disabled', info.disabled);

    // Clamp a quantity someone was about to order if stock just dropped below it.
    if (!info.disabled) {
      let val = parseInt($qtyInput.val(), 10) || 1;
      if (val > stock) $qtyInput.val(stock);
    }
  }

  // Poll every 5 seconds while the storefront grid is visible.
  stockPollTimer = setInterval(function () {
    if (!isAdmin) refreshVisibleStock();
  }, 5000);

  // Admin dashboard live refresh: orders, users (order counts), and stock
  // levels stay current if another admin/customer takes action elsewhere,
  // without needing to close and reopen the dashboard.
  adminPollTimer = setInterval(function () {
    if (isAdmin && $('#admin-dashboard').is(':visible')) {
      loadAdminOrders();
      loadAdminUsers();
      loadAdminStock();
    }
  }, 6000);

  // ========== 2. CATEGORY & SEARCH ==========
  $('.category-pill').click(function () {
    $('.category-pill').removeClass('active');
    $(this).addClass('active');
    currentCategory = $(this).data('cat');
    $('#section-title').text(currentCategory === 'All' ? 'Featured Products' : currentCategory);
    loadProducts(currentCategory, $('#search-input').val());
  });

  $('#search-input').on('keyup', function () {
    loadProducts(currentCategory, $(this).val());
  });

  // ========== 3. QUANTITY CONTROLS ==========
  $(document).on('click', '.qty-plus', function () {
    const input = $(this).siblings('.qty-input');
    const max = parseInt(input.attr('data-max'), 10);
    let val = parseInt(input.val()) || 1;
    if (!isNaN(max) && val >= max) {
      input.val(max);
      return;
    }
    input.val(++val);
  });
  $(document).on('click', '.qty-minus', function () {
    const input = $(this).siblings('.qty-input');
    let val = parseInt(input.val()) || 1;
    if (val > 1) input.val(--val);
  });
  // Clamp manual typing to the available stock too.
  $(document).on('change blur', '.qty-input', function () {
    const max = parseInt($(this).attr('data-max'), 10);
    let val = parseInt($(this).val(), 10) || 1;
    if (val < 1) val = 1;
    if (!isNaN(max) && val > max) val = max;
    $(this).val(val);
  });

  // ========== 4. CART LOGIC ==========
  $(document).on('click', '.add-cart-btn', function () {
    const id = $(this).data('id');
    const name = $(this).data('name');
    const price = parseFloat($(this).data('price'));
    const image = $(this).data('image');
    const $qtyInput = $(this).closest('.card-body').find('.qty-input');
    const quantity = parseInt($qtyInput.val()) || 1;
    const stockMax = parseInt($qtyInput.attr('data-max'), 10);

    const existing = cart.find(item => item.productId === id);
    const alreadyInCart = existing ? existing.quantity : 0;

    if (!isNaN(stockMax) && alreadyInCart + quantity > stockMax) {
      alert(`Only ${stockMax} in stock, and you already have ${alreadyInCart} in your cart.`);
      return;
    }

    if (existing) {
      existing.quantity += quantity;
    } else {
      cart.push({ productId: id, name, price, quantity, image });
    }
    updateCartUI();
    flyToCart($(this), image);
  });

  // ========== FUN FEEDBACK: flying item + badge bounce + "+N" pop ==========
  // Purely cosmetic - runs on top of the existing cart logic above, doesn't
  // change any cart state. Skips itself entirely if the user prefers
  // reduced motion.
  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function flyToCart($sourceBtn, imageUrl) {
    const $cartIcon = $('#cart-toggle');
    if ($cartIcon.length === 0 || $sourceBtn.length === 0) return;

    // Small "+1" label rises from the button regardless of motion prefs
    // (it's a fade+small-rise, not a big flight) - but skip if reduced motion.
    if (!prefersReducedMotion()) {
      const btnRect = $sourceBtn[0].getBoundingClientRect();
      const $pop = $('<div class="gb-add-pop">+1</div>').css({
        left: (btnRect.left + btnRect.width / 2) + 'px',
        top: (btnRect.top - 6) + 'px'
      });
      $('body').append($pop);
      requestAnimationFrame(function () {
        $pop.css({ transform: 'translate(-50%, -34px)', opacity: 0 });
      });
      setTimeout(function () { $pop.remove(); }, 650);

      // Flying image chip that arcs from the button to the cart icon.
      const cartRect = $cartIcon[0].getBoundingClientRect();
      const size = 40;
      const $flyer = $('<div class="gb-fly-item"></div>').css({
        left: (btnRect.left + btnRect.width / 2 - size / 2) + 'px',
        top: (btnRect.top + btnRect.height / 2 - size / 2) + 'px',
        width: size + 'px',
        height: size + 'px',
        backgroundImage: imageUrl ? `url(${imageUrl})` : 'none',
        backgroundColor: imageUrl ? 'transparent' : 'var(--signal)'
      });
      $('body').append($flyer);
      // Force layout so the browser registers the start position before we
      // change it - otherwise the transition has nothing to animate from.
      void $flyer[0].offsetWidth;
      $flyer.css({
        left: (cartRect.left + cartRect.width / 2 - 8) + 'px',
        top: (cartRect.top + cartRect.height / 2 - 8) + 'px',
        width: '16px',
        height: '16px',
        opacity: 0.15,
        transform: 'rotate(300deg)'
      });
      setTimeout(function () { $flyer.remove(); }, 580);
    }

    // Cart icon shake + badge bounce always play (short, cheap, and the
    // bounce keyframe itself already gets neutralized by the global
    // reduced-motion rule).
    setTimeout(function () {
      $cartIcon.addClass('gb-shake');
      setTimeout(function () { $cartIcon.removeClass('gb-shake'); }, 400);
    }, prefersReducedMotion() ? 0 : 480);
  }

  $(document).on('click', '.cart-remove-btn', function () {
    const id = $(this).data('id');
    cart = cart.filter(item => item.productId !== id);
    updateCartUI();
  });

  $(document).on('click', '.cart-qty-btn', function () {
    const id = $(this).data('id');
    const delta = parseInt($(this).data('delta'));
    const item = cart.find(i => i.productId === id);
    if (item) {
      item.quantity += delta;
      if (item.quantity <= 0) {
        cart = cart.filter(i => i.productId !== id);
      }
      updateCartUI();
    }
  });

  function updateCartUI() {
    localStorage.setItem('gearbari_cart', JSON.stringify(cart));
    const totalQty = cart.reduce((sum, i) => sum + i.quantity, 0);
    $cartBadge.text(totalQty);
    $cartBadge.addClass('gb-bounce');
    setTimeout(function () { $cartBadge.removeClass('gb-bounce'); }, 450);

    if (cart.length === 0) {
      $cartItemsList.html('<p class="text-muted text-center">Your cart is empty.</p>');
      $cartTotal.text('0');
      return;
    }

    let html = '';
    let total = 0;
    cart.forEach(item => {
      total += item.price * item.quantity;
      html += `
        <div class="cart-item">
          <div>
            <img src="${item.image}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 8px;" class="me-2">
            <span>${item.name}</span>
          </div>
          <div class="item-qty">
            <button class="cart-qty-btn" data-id="${item.productId}" data-delta="-1">-</button>
            <span>${item.quantity}</span>
            <button class="cart-qty-btn" data-id="${item.productId}" data-delta="1">+</button>
            <button class="btn btn-sm btn-danger cart-remove-btn" data-id="${item.productId}"><i class="bi bi-trash3"></i></button>
          </div>
          <span>${(item.price * item.quantity).toLocaleString()} ৳</span>
        </div>
      `;
    });
    $cartItemsList.html(html);
    $cartTotal.text(total.toLocaleString());
  }

  // ========== 5. CHECKOUT ==========
  $('#checkout-btn').click(function () {
    const subtotal = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
    $orderSubtotal.text(subtotal.toLocaleString());
    $orderDelivery.val('');
    $orderDeliveryCharge.text('0');
    $orderTotal.text(subtotal.toLocaleString());
    $('#orderModal').modal('show');
  });

  $('#order-delivery').change(function () {
    const option = $(this).val();
    let deliveryCharge = 0;
    if (option === 'Inside Dhaka') deliveryCharge = 80;
    else if (option === 'Outside Dhaka') deliveryCharge = 100;
    $orderDeliveryCharge.text(deliveryCharge);

    const subtotal = parseInt($orderSubtotal.text().replace(/,/g, '')) || 0;
    const total = subtotal + deliveryCharge;
    $orderTotal.text(total.toLocaleString());
  });

  // Submit order
  $('#order-form').submit(function (e) {
    e.preventDefault();

    const customerName = $('#order-name').val().trim();
    const customerPhone = $('#order-phone').val().trim();
    const customerAddress = $('#order-address').val().trim();
    const deliveryOption = $('#order-delivery').val();

    if (!customerName || !customerPhone || !customerAddress || !deliveryOption) {
      alert('Please fill all fields.');
      return;
    }

    const orderData = {
      items: cart.map(item => ({
        productId: item.productId,
        quantity: item.quantity
      })),
      deliveryOption,
      customerName,
      customerPhone,
      customerAddress
    };

    $.ajax({
      url: '/api/orders',
      method: 'POST',
      contentType: 'application/json',
      data: JSON.stringify(orderData),
      success: function (res) {
        cart = [];
        updateCartUI();
        $('#orderModal').modal('hide');
        $('#cartModal').modal('hide');
        $('#order-form')[0].reset();
        $orderDeliveryCharge.text('0');
        $orderTotal.text('0');

        // Auto-login the customer under the account this order was placed
        // under (new or returning), so they land signed-in on their own
        // account page instead of staying a logged-out guest.
        if (res.token && !isAdmin) {
          token = res.token;
          localStorage.setItem('token', token);
        }

        // Take them to their own account page (real page, not a popup) so
        // they can see their details and full order history, with this
        // order highlighted at the top.
        window.location.href = 'account.html?order=' + encodeURIComponent(res.invoiceNumber);
      },
      error: function (err) {
        alert('Error placing order: ' + err.responseJSON.error);
      }
    });
  });

  // NOTE: invoice display/printing now happens on the dedicated account.html
  // page (see account.js) right after checkout redirects the customer there,
  // instead of a popup modal on this page.

  // ========== 7. AUTH: LOGIN & REGISTER ==========
  $('#login-form').submit(function (e) {
    e.preventDefault();
    const username = $('#login-username').val().trim();
    const password = $('#login-password').val().trim();
    $.ajax({
      url: '/api/auth/login',
      method: 'POST',
      contentType: 'application/json',
      data: JSON.stringify({ username, password }),
      success: function (res) {
        handleLoginSuccess(res);
      },
      error: function () {
        alert('Invalid credentials. Please check your name and phone.');
      }
    });
  });

  $('#register-form').submit(function (e) {
    e.preventDefault();
    const name = $('#reg-name').val().trim();
    const phone = $('#reg-phone').val().trim();
    $.ajax({
      url: '/api/auth/register',
      method: 'POST',
      contentType: 'application/json',
      data: JSON.stringify({ name, phone }),
      success: function (res) {
        handleLoginSuccess(res);
      },
      error: function (err) {
        alert(err.responseJSON.error);
      }
    });
  });

  function handleLoginSuccess(res) {
    token = res.token;
    localStorage.setItem('token', token);
    $('#loginModal').modal('hide');
    $('#login-modal-btn').addClass('d-none');
    $('#user-display').removeClass('d-none').text('Hello, ' + (res.name || res.username));
    $('#logout-btn').removeClass('d-none');

    if (res.role === 'admin') {
      isAdmin = true;
      currentUser = 'admin';
      $('#admin-dashboard').show();
      $('#product-grid').hide();
      $('.category-pill').hide();
      $('#section-title').text('Admin Dashboard');
      loadAdminDashboard();
      loadAdminOrders();
      loadAdminUsers();
      loadSalesSummary();
    } else {
      isAdmin = false;
      currentUser = 'customer';
      $('#my-orders-link').removeClass('d-none');
    }
  }

  // ========== 8. LOGOUT ==========
  $('#logout-btn').click(function () {
    localStorage.removeItem('token');
    token = null;
    isAdmin = false;
    currentUser = null;
    $('#logout-btn').addClass('d-none');
    $('#login-modal-btn').removeClass('d-none');
    $('#user-display').addClass('d-none').text('');
    $('#admin-add-btn').hide();
    $('#admin-dashboard-btn').hide();
    $('#my-orders-link').addClass('d-none');
    $('#admin-dashboard').hide();
    $('#product-grid').show();
    $('.category-pill').show();
    $('#section-title').text('Featured Products');
    $('.modal').modal('hide');
    loadProducts(currentCategory);
  });

  // ========== 9. CUSTOMER: MY ACCOUNT ==========
  // "My Account" is now a real page (account.html) with the customer's
  // details and full order history, instead of a popup modal - so the nav
  // button is a plain link and needs no click handler here. We just guard
  // against a logged-out customer clicking it before a token exists.
  $('#my-orders-link').click(function (e) {
    if (!token) {
      e.preventDefault();
      alert('Please login first.');
      $('#loginModal').modal('show');
    }
  });

  // ========== 10. ADMIN DASHBOARD ==========
  function loadAdminDashboard() {
    $('#admin-dashboard').show();
    $('#product-grid').hide();
    $('.category-pill').hide();
  }

  function loadAdminOrders() {
    if (!isAdmin) return;
    $.ajax({
      url: '/api/admin/orders',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token },
      success: function (orders) {
        const $list = $('#admin-orders-list');
        $list.empty();
        orders.forEach(o => {
          const row = `
            <tr>
              <td>${o.invoiceNumber}</td>
              <td>${o.customerName}</td>
              <td>৳${o.totalAmount}</td>
              <td><span class="badge bg-${o.status === 'Delivered' ? 'success' : o.status === 'In Shipping' ? 'warning' : 'secondary'}">${o.status}</span></td>
              <td>
                <select class="form-select form-select-sm bg-dark text-white border-secondary order-status-select" data-id="${o._id}">
                  <option value="Pending" ${o.status === 'Pending' ? 'selected' : ''}>Pending</option>
                  <option value="In Shipping" ${o.status === 'In Shipping' ? 'selected' : ''}>In Shipping</option>
                  <option value="Delivered" ${o.status === 'Delivered' ? 'selected' : ''}>Delivered</option>
                </select>
              </td>
            </tr>
          `;
          $list.append(row);
        });
        $('.order-status-select').change(function () {
          const id = $(this).data('id');
          const status = $(this).val();
          $.ajax({
            url: `/api/admin/orders/${id}/status`,
            method: 'PUT',
            headers: { 'Authorization': 'Bearer ' + token },
            contentType: 'application/json',
            data: JSON.stringify({ status }),
            success: function () {
              alert('Order status updated.');
              loadAdminOrders();
            },
            error: function () {
              alert('Error updating status.');
            }
          });
        });
      }
    });
  }

  function loadAdminUsers() {
    $.ajax({
      url: '/api/admin/users',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token },
      success: function (users) {
        const $list = $('#admin-users-list');
        $list.empty();
        users.forEach(u => {
          // orderCount comes straight from the backend (actual count of that
          // customer's orders)
          const row = `<tr><td>${u.name}</td><td>${u.phone}</td><td>${u.orderCount}</td></tr>`;
          $list.append(row);
        });
      }
    });
  }

  function loadAdminStock() {
    $.ajax({
      url: '/api/admin/products',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token },
      success: function (products) {
        const $tbody = $('#admin-product-list');
        $tbody.empty();
        products.forEach(p => {
          const row = `
            <tr>
              <td>${p.name}</td>
              <td>${p.category}</td>
              <td>${p.price}</td>
              <td><span id="stock-display-${p._id}">${p.stock}</span></td>
              <td>
                <div class="input-group input-group-sm">
                  <input type="number" id="stock-input-${p._id}" class="form-control form-control-sm bg-dark text-white border-secondary" value="${p.stock}" style="width: 70px;">
                  <button class="btn btn-outline-warning btn-sm update-stock-btn" data-id="${p._id}">Update</button>
                </div>
              </td>
            </tr>
          `;
          $tbody.append(row);
        });
      }
    });
  }

  function loadSalesSummary() {
    $.ajax({
      url: '/api/admin/sales',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token },
      success: function (data) {
        let html = '<h5>Sales by Date</h5><table class="table table-dark"><thead><tr><th>Date</th><th>Orders</th><th>Revenue</th></tr></thead><tbody>';
        data.forEach(d => {
          html += `<tr><td>${d._id}</td><td>${d.count}</td><td>৳${d.total}</td></tr>`;
        });
        html += '</tbody></table>';
        $('#sales-summary').html(html);
      }
    });
  }

  // Update stock (admin)
  $(document).on('click', '.update-stock-btn', function () {
    const id = $(this).data('id');
    const newStock = parseInt($(`#stock-input-${id}`).val());
    if (isNaN(newStock) || newStock < 0) {
      alert('Please enter a valid stock number.');
      return;
    }
    $.ajax({
      url: `/api/admin/products/${id}/stock`,
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token },
      contentType: 'application/json',
      data: JSON.stringify({ stock: newStock }),
      success: function (updatedProduct) {
        $(`#stock-display-${id}`).text(updatedProduct.stock);
        $(`#stock-input-${id}`).val(updatedProduct.stock);
        // Immediately reflect the new number on the live storefront card too,
        // instead of waiting for the next 5-second poll.
        applyStockToCard(updatedProduct._id, updatedProduct.stock);
      },
      error: function (err) {
        alert('Error updating stock: ' + err.responseJSON.error);
      }
    });
  });

  // ========== 11. ADMIN: ADD PRODUCT ==========
  $('#add-product-form').submit(function (e) {
    e.preventDefault();
    const productData = {
      name: $('#prod-name').val(),
      price: $('#prod-price').val(),
      category: $('#prod-category').val(),
      image: $('#prod-image').val(),
      badge: $('#prod-badge').val(),
      stock: $('#prod-stock').val()
    };

    $.ajax({
      url: '/api/admin/products',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      contentType: 'application/json',
      data: JSON.stringify(productData),
      success: function () {
        $('#addProductModal').modal('hide');
        $('#add-product-form')[0].reset();
        alert('Product added to MongoDB!');
        loadProducts(currentCategory);
        if (isAdmin) loadAdminStock();
      },
      error: function (err) {
        alert('Error adding product: ' + err.responseJSON.error);
      }
    });
  });

  // ========== 12. SEED BUTTON (Admin) ==========
  // Safe to click any time now: it only ADDS any missing starter products
  // and never deletes or resets existing products/stock.
  $('#seed-btn-admin').click(function () {
    $.ajax({
      url: '/api/seed',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      success: function (res) {
        alert(res.message);
        loadProducts(currentCategory);
        if (isAdmin) loadAdminStock();
      },
      error: function (err) {
        alert('Error seeding products: ' + (err.responseJSON ? err.responseJSON.error : err.statusText));
      }
    });
  });

  // Admin: "Dashboard" nav button re-shows the dashboard view and refreshes
  // everything (previously pointed at a modal that didn't exist and did nothing).
  $('#admin-dashboard-btn').click(function () {
    if (!isAdmin) return;
    loadAdminDashboard();
    loadAdminOrders();
    loadAdminUsers();
    loadSalesSummary();
    loadAdminStock();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ========== 13. AUTO-LOGIN & INIT ==========
  updateCartUI(); // restore cart badge/list from localStorage on page load

  if (token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.role === 'admin') {
        isAdmin = true;
        currentUser = 'admin';
        $('#login-modal-btn').addClass('d-none');
        $('#user-display').removeClass('d-none').text('Hello, ' + payload.username);
        $('#logout-btn').removeClass('d-none');
        $('#admin-add-btn').show();
        $('#admin-dashboard-btn').show();
        loadAdminDashboard();
        loadAdminOrders();
        loadAdminUsers();
        loadSalesSummary();
        loadAdminStock();
      } else {
        isAdmin = false;
        currentUser = 'customer';
        $('#login-modal-btn').addClass('d-none');
        $('#user-display').removeClass('d-none').text('Hello, ' + (payload.name || payload.username));
        $('#logout-btn').removeClass('d-none');
        $('#my-orders-link').removeClass('d-none');
        loadProducts(currentCategory);
      }
    } catch (e) {
      localStorage.removeItem('token');
      token = null;
      loadProducts(currentCategory);
    }
  } else {
    loadProducts(currentCategory);
  }
});