$(document).ready(function () {
  const token = localStorage.getItem('token') || null;
  const urlParams = new URLSearchParams(window.location.search);
  const justOrderedInvoice = urlParams.get('order');

  // No token at all -> nothing to show, send them back to the store.
  if (!token) {
    $('#logged-out-state').removeClass('d-none');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(atob(token.split('.')[1]));
  } catch (e) {
    localStorage.removeItem('token');
    $('#logged-out-state').removeClass('d-none');
    return;
  }

  // Admins don't have an "account/order history" page - send them to the
  // storefront/dashboard instead.
  if (payload.role !== 'customer') {
    window.location.href = 'index.html';
    return;
  }

  $('#account-view').removeClass('d-none');

  const displayName = payload.name || payload.username || 'Customer';
  $('#account-name').text(displayName);
  $('#account-phone').text(payload.phone || '-');
  $('#account-avatar').text(displayName.trim().charAt(0).toUpperCase() || '?');

  if (justOrderedInvoice) {
    $('#just-ordered-banner').removeClass('d-none');
  }

  function statusBadgeClass(status) {
    if (status === 'Delivered') return 'success';
    if (status === 'In Shipping') return 'warning';
    return 'secondary';
  }

  function renderOrders(orders) {
    const $list = $('#orders-list');
    $list.empty();

    if (!orders || orders.length === 0) {
      $list.html(`
        <div class="gb-empty-state">
          <i class="bi bi-box-seam fs-1 mb-3 d-block"></i>
          <h5>No orders yet</h5>
          <p>Once you place an order, it'll show up here.</p>
          <a href="index.html" class="btn btn-warning fw-bold mt-2">Start Shopping</a>
        </div>
      `);
      return;
    }

    orders.forEach(function (order) {
      const isHighlighted = justOrderedInvoice && order.invoiceNumber === justOrderedInvoice;
      const itemsSummary = order.items.map(i => `${i.name} x${i.quantity}`).join(', ');
      const dateStr = order.createdAt ? new Date(order.createdAt).toLocaleString() : '';

      const card = $(`
        <div class="gb-order-card ${isHighlighted ? 'gb-order-highlight' : ''}" data-order-id="${order._id}">
          <div class="gb-order-top">
            <span class="gb-order-invoice"><i class="bi bi-receipt"></i> ${order.invoiceNumber}</span>
            <span class="badge bg-${statusBadgeClass(order.status)}">${order.status}</span>
          </div>
          <div class="gb-order-items">${itemsSummary}</div>
          <div class="text-muted small mb-2"><i class="bi bi-geo-alt"></i> ${order.customerAddress || ''}</div>
          <div class="gb-order-bottom">
            <span class="text-muted small">${dateStr}</span>
            <div class="d-flex align-items-center gap-3">
              <span class="gb-order-total">Total: ৳${order.totalAmount}</span>
              <button class="btn btn-sm btn-outline-light print-invoice-btn" data-order-id="${order._id}">
                <i class="bi bi-printer"></i> Print Invoice
              </button>
            </div>
          </div>
        </div>
      `);
      $list.append(card);
    });
  }

  let ordersCache = [];

  function loadOrders() {
    $.ajax({
      url: '/api/orders/my',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token },
      success: function (orders) {
        ordersCache = orders;
        renderOrders(orders);
      },
      error: function (err) {
        if (err.status === 401 || err.status === 403) {
          localStorage.removeItem('token');
          $('#account-view').addClass('d-none');
          $('#logged-out-state').removeClass('d-none');
        }
      }
    });
  }

  loadOrders();

  // ========== PRINT INVOICE (per order, as a PDF) ==========
  $(document).on('click', '.print-invoice-btn', function () {
    const orderId = $(this).data('order-id');
    const order = ordersCache.find(o => o._id === orderId);
    if (!order) return;

    const $temp = $(`
      <div id="temp-invoice" style="position: fixed; top: -9999px; left: -9999px; width: 700px; background: #0d0f14; color: #fff; padding: 24px;">
        <h4>GearBari</h4>
        <p><strong>Invoice:</strong> ${order.invoiceNumber}</p>
        <p><strong>Date:</strong> ${new Date(order.createdAt).toLocaleString()}</p>
        <hr>
        <p><strong>Customer:</strong> ${order.customerName}</p>
        <p><strong>Phone:</strong> ${order.customerPhone}</p>
        <p><strong>Address:</strong> ${order.customerAddress}</p>
        <p><strong>Delivery:</strong> ${order.deliveryOption} (Charge: ৳${order.deliveryCharge})</p>
        <hr>
        <table class="table table-dark table-striped">
          <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
          <tbody>
            ${order.items.map(i => `<tr><td>${i.name}</td><td>${i.quantity}</td><td>৳${i.price}</td><td>৳${i.price * i.quantity}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><th colspan="3">Total</th><th>৳${order.totalAmount}</th></tr></tfoot>
        </table>
      </div>
    `);
    $('body').append($temp);

    html2canvas(document.getElementById('temp-invoice'), { scale: 2 }).then(canvas => {
      const imgData = canvas.toDataURL('image/png');
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF('p', 'mm', 'a4');
      const imgWidth = 190;
      const pageHeight = 277;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;
      let heightLeft = imgHeight;
      let position = 10;
      pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
      while (heightLeft > 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }
      pdf.save(`Invoice_${order.invoiceNumber}.pdf`);
      $temp.remove();
    });
  });

  // ========== LOGOUT ==========
  $('#logout-btn').click(function () {
    localStorage.removeItem('token');
    window.location.href = 'index.html';
  });
});
