package com.acme.orders.api;

import com.acme.orders.domain.Order;
import com.acme.orders.service.OrderService;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api" + ApiPaths.ORDERS)
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @PostMapping
    public ResponseEntity<Order> create(@RequestBody CreateOrderRequest request) {
        return ResponseEntity.ok(orderService.placeOrder(request));
    }

    @GetMapping("/{id}")
    public Order get(@PathVariable Long id) {
        return orderService.getOrder(id);
    }

    @GetMapping
    public List<Order> list(@RequestParam(required = false) String customerId) {
        return orderService.listOrders(customerId);
    }

    @RequestMapping(value = "/{id}/cancel", method = RequestMethod.POST)
    public void cancel(@PathVariable("id") Long id) {
        orderService.cancel(id);
    }
}
