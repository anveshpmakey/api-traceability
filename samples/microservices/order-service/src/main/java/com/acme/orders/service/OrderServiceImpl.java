package com.acme.orders.service;

import com.acme.orders.api.CreateOrderRequest;
import com.acme.orders.client.CustomerClient;
import com.acme.orders.client.InventoryClient;
import com.acme.orders.client.PaymentClient;
import com.acme.orders.domain.Order;
import com.acme.orders.domain.OrderRepository;
import com.acme.orders.events.OrderEventPublisher;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class OrderServiceImpl implements OrderService {

    private final OrderRepository orderRepository;
    private final InventoryClient inventoryClient;
    private final PaymentClient paymentClient;
    private final CustomerClient customerClient;
    private final OrderEventPublisher events;

    @Override
    @Transactional
    public Order placeOrder(CreateOrderRequest request) {
        customerClient.verify(request.customerId());
        inventoryClient.reserve(request.sku(), request.quantity());
        paymentClient.charge(request.customerId(), request.amountCents());
        Order saved = orderRepository.save(new Order());
        events.orderPlaced(saved);
        return saved;
    }

    @Override
    public Order getOrder(Long id) {
        return orderRepository.findById(id).orElseThrow();
    }

    @Override
    public List<Order> listOrders(String customerId) {
        return orderRepository.findByCustomerId(customerId);
    }

    @Override
    public void cancel(Long id) {
        orderRepository.markCancelled(id);
        inventoryClient.release(id);
    }
}
