package com.acme.orders.service;

import com.acme.orders.api.CreateOrderRequest;
import com.acme.orders.domain.Order;
import java.util.List;

public interface OrderService {
    Order placeOrder(CreateOrderRequest request);
    Order getOrder(Long id);
    List<Order> listOrders(String customerId);
    void cancel(Long id);
}
